#!/usr/bin/env python3
"""
Fictional Fiwind Capital "Estado de Cuenta" PDF (cuenta comitente) for tests.
Same column layout as the real monthly statement; every name, account number,
CUIT and amount here is made up. Output: fixtures/fiwind/estado-cuenta-ejemplo.pdf
"""
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
import os

out = os.path.join(os.path.dirname(__file__), "..", "fixtures", "fiwind", "estado-cuenta-ejemplo.pdf")
W, H = landscape(A4)
c = canvas.Canvas(out, pagesize=(W, H), pageCompression=0)
c.setTitle("RptCtasCorrientesConsolidado")

def header():
    c.setFont("Helvetica", 7)
    for i, t in enumerate([
        "Fiwind Capital S.A.", "Calle Falsa 123, piso 1, Ciudad Ejemplo, CP: 1000",
        "Telefono: 0000000000", "ejemplo@fiwind.invalid", "CUIT: 30-00000000-0",
    ]):
        c.drawString(40, H - 30 - i * 9, t)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(W / 2 - 40, H - 30, "Estado de Cuenta")
    c.setFont("Helvetica", 8)
    c.drawString(W - 260, H - 45, "Fecha desde:   1/9/2026")
    c.drawString(W - 260, H - 55, "Fecha hasta:  30/9/2026")
    c.drawString(W / 2 - 80, H - 75, "Cuenta: Titular Ejemplo - (99999)")
    c.drawString(W / 2 - 80, H - 85, "Mail: titular@example.com - CUIT: 20000000001")
    cols = [("Concertación", 40), ("Liquidación", 100), ("Detalle", 170), ("Valor Nominal", 330),
            ("Importe Bruto", 390), ("Precio", 450), ("Importe Neto", 495), ("Saldo", 560),
            ("Simbolo", 610)]
    c.setFont("Helvetica-Bold", 7)
    for t, x in cols:
        c.drawString(x, H - 105, t)

header()
y = H - 125
c.setFont("Helvetica", 7)
c.drawString(60, y, "Disponible"); y -= 10
c.drawString(70, y, "Monedas"); y -= 10
c.drawString(80, y, "Pesos - $"); y -= 14
c.drawString(170, y, "Saldo Anterior"); c.drawRightString(590, y, "-20.0700"); c.drawString(612, y, "$"); y -= 16

def row(d1, d2, detail, nums, symbol, detail2=None):
    # Draw order matters: the PDF text extractor reads the content stream in
    # drawing order, and the real statement draws the dates first, then the
    # (wrapped) detail, then the amounts and the symbol.
    global y
    c.drawString(40, y - 9, d1); c.drawString(100, y - 9, d2)
    c.drawString(170, y, detail)
    if detail2:
        c.drawString(170, y - 18, detail2)
    xs = {1: [520], 2: [420, 520], 3: [420, 520, 590]}[len(nums)]
    for x, n in zip(xs, nums):
        c.drawRightString(x + 30 if len(nums) < 3 or x != 590 else 590, y - 9, n)
    c.drawString(612, y - 9, symbol)
    y -= 36 if detail2 else 27

row("1/9/2026", "1/9/2026", "Depósito transferencia bancaria", ["150000.00", "150000.00", "149979.93"], "$")
row("8/9/2026", "10/9/2026", "Compra FONDO EJEMPLO A", ["-50000.00", "-50000.00", "99979.93"], "$")
row("29/9/2026", "29/9/2026", "Movimiento Manual / Ajuste de saldo", ["20.07", "20.07", "100000.00"], "$", "residual cuenta 99999 (ARS)")
c.drawString(170, y, "Saldo al 30/09/2026"); c.drawRightString(590, y, "100000.00"); c.drawString(612, y, "$"); y -= 18
c.drawString(80, y, "Dolares - USD"); y -= 14
c.drawString(170, y, "Saldo Anterior"); c.drawRightString(590, y, "0.0000"); c.drawString(612, y, "USD"); y -= 16
row("15/9/2026", "15/9/2026", "Cobro de renta TITULO EJEMPLO", ["12.50", "12.50", "12.50"], "USD")
c.drawString(170, y, "Saldo al 30/09/2026"); c.drawRightString(590, y, "12.50"); c.drawString(612, y, "USD")
c.setFont("Helvetica", 6)
c.drawString(W / 2 - 60, 20, "Sistema aprobado por C.N.V.")
c.save()
print("wrote", os.path.abspath(out))
