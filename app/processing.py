"""Conservative local extraction. Document text never becomes executable instructions."""
import io, re, subprocess, tempfile, shutil, os
from pathlib import Path
from decimal import Decimal, InvalidOperation
from PIL import Image, ImageOps
from pypdf import PdfReader


def money(value):
    if value is None or str(value).strip() == '':
        return None
    if isinstance(value, bool):
        raise ValueError('Montante inválido.')
    s = str(value).strip().replace('€', '').replace('EUR', '').replace('\u00a0', '').replace(' ', '')
    if ',' in s:
        s = s.replace('.', '').replace(',', '.')
    try:
        d = Decimal(s)
        if not d.is_finite() or abs(d) > Decimal('10000000000'):
            raise ValueError('Montante inválido.')
        return int((d * 100).quantize(Decimal('1')))
    except InvalidOperation as e:
        raise ValueError('Montante inválido.') from e


def date_iso(value):
    from datetime import datetime
    if not value:
        return None
    for fmt in ('%Y-%m-%d','%d/%m/%Y','%d-%m-%Y','%Y%m%d','%d.%m.%Y'):
        try:
            return datetime.strptime(str(value).strip(), fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError('Data inválida. Use DD/MM/AAAA.')


def qr_read(path):
    import cv2
    im = cv2.imread(str(path))
    if im is None:
        return []
    detector = cv2.QRCodeDetector()
    ok, values, _, _ = detector.detectAndDecodeMulti(im)
    return [v for v in values if v] if ok else [detector.detectAndDecode(im)[0]]


def qr_fields(value):
    if not value.startswith('A:') or '*O:' not in value:
        return None
    parts = dict(p.split(':',1) for p in value.split('*') if ':' in p)
    fields = {}
    for k, out in [('A','supplier_nif'),('B','recipient_nif'),('G','number')]:
        if parts.get(k): fields[out] = parts[k]
    try: fields['date'] = date_iso(parts.get('F'))
    except ValueError: pass
    for k, out in [('N','vat'),('O','total')]:
        if parts.get(k):
            try: fields[out] = money(parts[k]) / 100
            except ValueError: pass
    if fields.get('total') is not None and fields.get('vat') is not None:
        fields['net'] = round(fields['total']-fields['vat'],2)
    codes = {'FT':'Fatura','FR':'Fatura-recibo','RC':'Recibo','NC':'Nota de crédito'}
    fields['type'] = codes.get(parts.get('D'), 'Outro')
    fields['currency'] = 'EUR'
    rates = []
    for region in ('I','J','K'):
        for base, tax, rate in [('3','4','reduzida'),('5','6','intermédia'),('7','8','normal')]:
            if parts.get(region+base) or parts.get(region+tax):
                rates.append({'region':parts.get(region+'1'),'rate':rate,'base':parts.get(region+base),'vat':parts.get(region+tax)})
    fields['vat_rates'] = rates
    return fields


def extract(path, mime):
    pages, qrs = [], []
    with tempfile.TemporaryDirectory() as temp:
        images = []
        if mime == 'application/pdf':
            reader = PdfReader(path)
            if len(reader.pages) > 100:
                raise ValueError('OCR limitado a 100 páginas; introduza os dados manualmente.')
            pages = [(p.extract_text() or '') for p in reader.pages]
            # Render to read fiscal QR and perform OCR on scanned pages.
            if shutil.which('pdftoppm'):
                for i, page in enumerate(pages):
                    prefix = str(Path(temp)/f'page-{i+1}')
                    subprocess.run(['pdftoppm','-f',str(i+1),'-l',str(i+1),'-scale-to','1800','-png','-singlefile',str(path),prefix],check=True,capture_output=True,timeout=60)
                    images.append((i, Path(prefix+'.png')))
        else:
            im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
            p = Path(temp)/'image.png'
            im.save(p)
            images = [(0,p)]
            pages = ['']
        for i, p in images:
            try:
                qrs.extend(v for v in qr_read(p) if v)
            except Exception:
                pass
            if len(pages[i].strip()) < 40:
                if not shutil.which('tesseract'):
                    raise ValueError('Tesseract não instalado. Introdução manual disponível.')
                bundled = Path(__file__).resolve().parent.parent/'.tools'/'tessdata'
                tessdata = os.environ.get('TESSDATA_PREFIX') or (str(bundled) if bundled.exists() else None)
                extra = ['--tessdata-dir',tessdata] if tessdata else []
                langs = subprocess.run(['tesseract','--list-langs',*extra],capture_output=True,text=True,timeout=10).stdout
                lang = 'por+eng' if 'por' in langs else 'eng'
                result = subprocess.run(['tesseract',str(p),'stdout',*extra,'-l',lang],capture_output=True,text=True,check=True,timeout=90)
                pages[i] = pages[i]+'\n\n'+result.stdout if pages[i].strip() else result.stdout
    text = '\n\n'.join(pages)
    fields, confidence, warnings = {}, {}, []
    for label, key in [('fornecedor','supplier'),('destinatário','recipient'),('descrição','description')]:
        m = re.search(rf'(?im)^{label}\s*:\s*(.+)$',text)
        if m: fields[key] = m.group(1).strip(); confidence[key] = 'baixa'
    for label,key in [('NIF fornecedor','supplier_nif'),('NIF destinatário','recipient_nif')]:
        m = re.search(rf'(?im){label}\s*:\s*(\d{{9}})',text)
        if m: fields[key] = m.group(1); confidence[key] = 'baixa'
    for label,key in [('total(?: a pagar)?','total'),('total sem IVA|subtotal','net'),('total IVA|IVA total','vat')]:
        m = re.search(rf'(?im)^\s*(?:{label})\s*[:\-]?\s*([\d .]+[,.]\d{{2}})\s*(?:€|EUR)?\s*$',text)
        if m:
            try: fields[key] = money(m.group(1))/100; confidence[key] = 'baixa'
            except ValueError: pass
    m = re.search(r'(?i)(?:data(?: de emissão)?)\s*:?\s*(\d{2}[/-]\d{2}[/-]\d{4}|\d{4}-\d{2}-\d{2})',text)
    if m:
        try: fields['date'] = date_iso(m.group(1)); confidence['date'] = 'baixa'
        except ValueError: pass
    m = re.search(r'(?i)(fatura[- ]recibo|fatura|factura|recibo|nota de crédito|orçamento)\s*(?:n[.ºo°]*\s*)?[:#]?\s*([A-Z]{0,5}\s*\d[\w/.-]*)',text)
    if m: fields['type'] = m.group(1).capitalize(); fields['number'] = m.group(2).strip(); confidence['number'] = 'baixa'
    fiscal = next((f for f in (qr_fields(q) for q in qrs) if f),None)
    if fiscal:
        for k,v in fiscal.items():
            if k in fields and str(fields[k]) != str(v): warnings.append(f'Divergência entre texto e QR: {k}. Confirme no original.')
            fields[k] = v; confidence[k] = 'QR fiscal — confirmar'
    # Only visibly delimited source lines are suggested; never infer missing measures.
    lines = []
    for page_num, page in enumerate(pages,1):
        for line in page.splitlines():
            cells = [x.strip() for x in re.split(r'\s*;\s*|\s*\|\s*|\t',line)]
            if len(cells) >= 4:
                try:
                    quantity = float(cells[1].replace(',','.'))
                    price = money(cells[3])/100
                    if quantity > 0 and price >= 0:
                        lines.append({'name':cells[0],'quantity':quantity,'unit':cells[2],'price':price,'page':page_num,'confidence':'baixa'})
                except (ValueError,TypeError): pass
    return {'fields':fields,'confidence':confidence,'warnings':warnings,'text':text[:150000],'lines':lines,'pages':len(pages),'method':'OCR local / texto PDF / QR fiscal','ai_configured':False}
