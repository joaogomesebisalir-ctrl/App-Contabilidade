-- Render template placeholders are replaced only with validated SQL identifiers.
-- These functions are callable ONLY by the server service_role, never anon/authenticated.
-- Temporarily allow the installing administrator to become the limited owner.
-- Restore existing membership settings after function creation.
DO $$ BEGIN
 IF NOT pg_has_role(current_user,'{{ROLE}}','SET') THEN
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member JOIN pg_roles g ON g.oid=m.grantor WHERE r.rolname='{{ROLE}}' AND u.rolname=current_user AND g.rolname=current_user) THEN
   PERFORM set_config('conta.temporary_membership','restore_set',true);
   EXECUTE format('GRANT {{ROLE}} TO %I WITH SET TRUE',current_user);
  ELSE
   PERFORM set_config('conta.temporary_membership','new_grant',true);
   EXECUTE format('GRANT {{ROLE}} TO %I WITH SET TRUE, INHERIT FALSE',current_user);
  END IF;
 END IF;
END $$;
GRANT CREATE ON SCHEMA public TO {{ROLE}};
SET ROLE {{ROLE}};
CREATE UNIQUE INDEX IF NOT EXISTS cc_single_admin ON {{SCHEMA}}.users(role) WHERE role='admin';

CREATE OR REPLACE FUNCTION public.cc_query(q text, params jsonb DEFAULT '[]', audit_info jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path={{SCHEMA}},pg_catalog AS $$
DECLARE rendered text := ''; quoted boolean := false; pos integer := 1; arg integer := 0;
 ch text; value jsonb; result jsonb := '[]'; affected bigint := 0; last_id bigint;
BEGIN
 IF q IS NULL OR length(q)>200000 OR q ~ ';|--|/\*' OR q !~* '^\s*(SELECT|INSERT|UPDATE|DELETE)\s' OR jsonb_typeof(params)<>'array' THEN
  RAISE EXCEPTION 'Pedido de dados inválido.';
 END IF;
 WHILE pos<=length(q) LOOP
  ch:=substr(q,pos,1);
  IF ch='''' THEN
   rendered:=rendered||ch;
   IF quoted AND substr(q,pos+1,1)='''' THEN rendered:=rendered||'''';pos:=pos+1;
   ELSE quoted:=NOT quoted;END IF;
  ELSIF ch='?' AND NOT quoted THEN
   IF arg>=jsonb_array_length(params) THEN RAISE EXCEPTION 'Parâmetros inválidos.';END IF;
   value:=params->arg;
   rendered:=rendered||CASE WHEN value='null'::jsonb THEN 'NULL' ELSE quote_literal(params->>arg) END;
   arg:=arg+1;
  ELSE rendered:=rendered||ch;END IF;
  pos:=pos+1;
 END LOOP;
 IF quoted OR arg<>jsonb_array_length(params) THEN RAISE EXCEPTION 'Parâmetros inválidos.';END IF;
 IF q !~* '^\s*SELECT\s' THEN
  PERFORM pg_advisory_xact_lock(913041337);
  PERFORM set_config('conta.edge_action',coalesce(audit_info->>'action',''),true);
  PERFORM set_config('conta.allow_duplicate',coalesce((audit_info->>'detail')::jsonb->>'confirm_duplicate','false'),true);
 END IF;
 IF q ~* '^\s*SELECT\s' THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) FROM ('||rendered||') t' INTO result;
 ELSIF q ~* '\sRETURNING\s' THEN
  EXECUTE 'WITH t AS ('||rendered||') SELECT coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) FROM t' INTO result;
 ELSE EXECUTE rendered;GET DIAGNOSTICS affected=ROW_COUNT;
 END IF;
 last_id:=(result->0->>'id')::bigint;
 IF audit_info IS NOT NULL THEN
  INSERT INTO audit(user_id,action,resource,resource_id,detail,created)
  VALUES((audit_info->>'user_id')::bigint,audit_info->>'action',audit_info->>'resource',
   CASE WHEN audit_info->>'resource_id'='$last' THEN last_id ELSE (audit_info->>'resource_id')::bigint END,
   coalesce(audit_info->>'detail','{}'),to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"+00:00"'));
 END IF;
 RETURN jsonb_build_object('rows',result,'id',last_id,'affected',affected);
END $$;
REVOKE ALL ON FUNCTION public.cc_query(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cc_query(text,jsonb,jsonb) TO service_role;

-- Recheck duplicates under the same transaction lock as the write. Legacy Flask
-- writes retain their existing confirmation flow (no conta.edge_action setting).
CREATE OR REPLACE FUNCTION {{SCHEMA}}.cc_duplicate_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path={{SCHEMA}},pg_catalog AS $$
DECLARE action text:=current_setting('conta.edge_action',true);meta jsonb;
BEGIN
 IF current_setting('conta.allow_duplicate',true)='true' THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='movements' THEN
  IF action='imported' AND EXISTS(SELECT 1 FROM movements WHERE fingerprint=NEW.fingerprint) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Possível movimento duplicado. Confirme antes de importar.';
  END IF;
 ELSE
  IF TG_OP='INSERT' AND action='uploaded' AND EXISTS(SELECT 1 FROM documents WHERE sha256=NEW.sha256 AND deleted IS NULL) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Possível ficheiro duplicado. Confirme antes de continuar.';
  ELSIF TG_OP='UPDATE' AND action='updated' THEN
   meta:=NEW.metadata::jsonb;
   IF coalesce(meta->>'supplier_nif','')<>'' AND coalesce(meta->>'number','')<>'' AND coalesce(meta->>'date','')<>'' AND nullif(meta->>'total','') IS NOT NULL
    AND EXISTS(SELECT 1 FROM documents d WHERE d.id<>NEW.id AND d.entity_id=NEW.entity_id AND d.deleted IS NULL
     AND d.metadata::jsonb->>'supplier_nif'=meta->>'supplier_nif' AND d.metadata::jsonb->>'number'=meta->>'number'
     AND d.metadata::jsonb->>'date'=meta->>'date' AND nullif(d.metadata::jsonb->>'total','')::numeric=nullif(meta->>'total','')::numeric) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Possível documento duplicado. Confirme antes de continuar.';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cc_duplicate_guard ON {{SCHEMA}}.documents;
CREATE TRIGGER cc_duplicate_guard BEFORE INSERT OR UPDATE OF metadata ON {{SCHEMA}}.documents FOR EACH ROW EXECUTE FUNCTION {{SCHEMA}}.cc_duplicate_guard();
DROP TRIGGER IF EXISTS cc_duplicate_guard ON {{SCHEMA}}.movements;
CREATE TRIGGER cc_duplicate_guard BEFORE INSERT ON {{SCHEMA}}.movements FOR EACH ROW EXECUTE FUNCTION {{SCHEMA}}.cc_duplicate_guard();

CREATE OR REPLACE FUNCTION {{SCHEMA}}.cc_allocation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path={{SCHEMA}},pg_catalog AS $$
DECLARE m movements%ROWTYPE;d documents%ROWTYPE;meta jsonb;used bigint;paid bigint;total bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(913041337);
 SELECT * INTO m FROM movements WHERE id=NEW.movement_id FOR UPDATE;
 SELECT * INTO d FROM documents WHERE id=NEW.document_id FOR UPDATE;
 IF m.id IS NULL OR d.id IS NULL OR d.deleted IS NOT NULL OR d.visibility<>'financial' OR m.entity_id<>d.entity_id THEN RAISE EXCEPTION 'Documento ou movimento inválido, ou de entidades diferentes.';END IF;
 meta:=d.metadata::jsonb;
 IF coalesce(meta->>'type','') NOT IN ('Fatura','Fatura-recibo','Recibo','Nota de crédito') OR ((meta->>'type'='Nota de crédito')<>(m.amount>0)) THEN RAISE EXCEPTION 'Tipo ou sinal do pagamento inválido.';END IF;
 total:=round(nullif(meta->>'total','')::numeric*100);
 SELECT coalesce(sum(amount),0) INTO used FROM allocations WHERE movement_id=m.id AND id<>coalesce(NEW.id,0);
 SELECT coalesce(sum(amount),0) INTO paid FROM allocations WHERE document_id=d.id AND id<>coalesce(NEW.id,0);
 IF total IS NULL OR NEW.amount<=0 OR NEW.amount>abs(m.amount)-used OR NEW.amount>total-paid THEN RAISE EXCEPTION 'A associação excede o saldo do movimento ou da fatura.';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cc_allocation_guard ON {{SCHEMA}}.allocations;
CREATE TRIGGER cc_allocation_guard BEFORE INSERT OR UPDATE ON {{SCHEMA}}.allocations FOR EACH ROW EXECUTE FUNCTION {{SCHEMA}}.cc_allocation_guard();

CREATE OR REPLACE FUNCTION {{SCHEMA}}.cc_document_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path={{SCHEMA}},pg_catalog AS $$
DECLARE paid bigint;total bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(913041337);
 SELECT coalesce(sum(amount),0) INTO paid FROM allocations WHERE document_id=OLD.id;
 total:=round(nullif(NEW.metadata::jsonb->>'total','')::numeric*100);
 IF paid>0 AND (total IS NULL OR total<paid OR (NEW.metadata::jsonb->>'type') IS DISTINCT FROM (OLD.metadata::jsonb->>'type') OR NEW.entity_id<>OLD.entity_id) THEN RAISE EXCEPTION 'Remova as associações antes de alterar o tipo, total ou entidade deste documento.';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cc_document_guard ON {{SCHEMA}}.documents;
CREATE TRIGGER cc_document_guard BEFORE UPDATE OF metadata,entity_id ON {{SCHEMA}}.documents FOR EACH ROW EXECUTE FUNCTION {{SCHEMA}}.cc_document_guard();

CREATE OR REPLACE FUNCTION {{SCHEMA}}.cc_replace_scope(target_id bigint, scopes jsonb)
RETURNS void LANGUAGE plpgsql SET search_path={{SCHEMA}},pg_catalog AS $$
DECLARE item jsonb;doc_id bigint;grant_id bigint;selected_entity bigint;seen bigint[]:='{}';
BEGIN
 IF jsonb_typeof(scopes)<>'array' THEN RAISE EXCEPTION 'Seleção inválida.';END IF;
 DELETE FROM grants WHERE user_id=target_id;
 FOR item IN SELECT value FROM jsonb_array_elements(scopes) LOOP
  selected_entity:=(item->>'entity_id')::bigint;
  IF selected_entity=ANY(seen) OR NOT EXISTS(SELECT 1 FROM entities WHERE id=selected_entity) THEN RAISE EXCEPTION 'Entidade inválida ou repetida.';END IF;
  seen:=array_append(seen,selected_entity);
  INSERT INTO grants(user_id,entity_id,all_documents,bank_access) VALUES(target_id,selected_entity,CASE WHEN coalesce((item->>'all_documents')::boolean,false) THEN 1 ELSE 0 END,CASE WHEN coalesce((item->>'bank_access')::boolean,false) THEN 1 ELSE 0 END) RETURNING id INTO grant_id;
  FOR doc_id IN SELECT DISTINCT value::bigint FROM jsonb_array_elements_text(coalesce(item->'document_ids','[]')) LOOP
   IF NOT EXISTS(SELECT 1 FROM documents WHERE id=doc_id AND documents.entity_id=selected_entity AND visibility='financial' AND deleted IS NULL) THEN RAISE EXCEPTION 'Documento privado, apagado ou de outra entidade.';END IF;
   INSERT INTO grant_documents VALUES(grant_id,doc_id);
  END LOOP;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.cc_scope(actor_id bigint, target_id bigint DEFAULT NULL, scopes jsonb DEFAULT NULL, invitation_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path={{SCHEMA}},pg_catalog AS $$
DECLARE actor users%ROWTYPE;inv invitations%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(913041337);
 SELECT * INTO actor FROM users WHERE id=actor_id AND active=1;
 IF actor.id IS NULL THEN RAISE EXCEPTION 'Acesso não autorizado.';END IF;
 IF invitation_hash IS NOT NULL THEN
  SELECT * INTO inv FROM invitations WHERE token_hash=invitation_hash FOR UPDATE;
  IF inv.id IS NULL OR inv.used IS NOT NULL OR inv.expires::timestamptz<clock_timestamp() OR actor.role<>'accountant' OR lower(actor.email)<>lower(inv.email) THEN RAISE EXCEPTION 'Convite inválido, expirado ou já utilizado.';END IF;
  PERFORM cc_replace_scope(actor_id,inv.scope::jsonb);
  UPDATE invitations SET used=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"+00:00"') WHERE id=inv.id;
 ELSE
  IF actor.role<>'admin' OR NOT EXISTS(SELECT 1 FROM users WHERE id=target_id AND role='accountant') THEN RAISE EXCEPTION 'Acesso não autorizado.';END IF;
  PERFORM cc_replace_scope(target_id,scopes);
  UPDATE invitations SET used=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"+00:00"') WHERE email=(SELECT email FROM users WHERE id=target_id) AND used IS NULL;
 END IF;
 INSERT INTO audit(user_id,action,resource,resource_id,created) VALUES(actor_id,CASE WHEN invitation_hash IS NULL THEN 'scope_changed' ELSE 'accepted' END,'users',coalesce(target_id,actor_id),to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"+00:00"'));
 RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.cc_scope(bigint,bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cc_scope(bigint,bigint,jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION public.cc_snapshot()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path={{SCHEMA}},pg_catalog AS $$
 SELECT jsonb_build_object('format','conta-clara-v1','schema','{{SCHEMA}}','tables',jsonb_build_object(
 'users',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM users t),
 'entities',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM entities t),
 'documents',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM documents t),
 'grants',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM grants t),
 'grant_documents',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM grant_documents t),
 'invitations',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM invitations t),
 'movements',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM movements t),
 'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM allocations t),
 'comments',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM comments t),
 'requests',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM requests t),
 'request_replies',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM request_replies t),
 'private_records',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM private_records t),
 'audit',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM audit t),
 'login_attempts',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM login_attempts t)))
$$;
REVOKE ALL ON FUNCTION public.cc_snapshot() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cc_snapshot() TO service_role;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM {{ROLE}};
DO $$ BEGIN
 IF current_setting('conta.temporary_membership',true)='restore_set' THEN
  EXECUTE format('GRANT {{ROLE}} TO %I WITH SET FALSE',current_user);
 ELSIF current_setting('conta.temporary_membership',true)='new_grant' THEN
  EXECUTE format('REVOKE {{ROLE}} FROM %I GRANTED BY %I',current_user,current_user);
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
