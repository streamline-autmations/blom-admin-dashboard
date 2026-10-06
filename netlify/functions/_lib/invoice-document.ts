import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import fetch from "node-fetch"
import { FREE_SHIPPING_THRESHOLD, FREE_SHIPPING_THRESHOLD_LABEL } from "../../../src/lib/shipping"

const LOGO_URL = "https://yvmnedjybrpvlupygusf.supabase.co/storage/v1/object/public/assets/blom_logo.png"

// Page dimensions (A4)
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const ITEM_ROW_HEIGHT = 16
const FOOTER_HEIGHT = 60 // Space needed for totals and footer

function money(n: any) {
  return "R " + Number(n || 0).toFixed(2)
}

// pdf-lib StandardFonts only encode WinAnsi (CP1252); emoji, warning signs,
// non-Latin scripts and smart punctuation make drawText throw and 500 the whole
// invoice. Normalize common punctuation to ASCII, then strip anything still
// unencodable so a stray glyph in a name/address/product title can never break it.
function sanitizeWinAnsi(value: any): string {
  if (value === null || value === undefined) return ""
  return String(value)
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[•●·]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function safeParseJson(value: any) {
  if (value == null) return null
  if (typeof value === "object") return value
  if (typeof value !== "string") return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function toNumberLoose(value: any): number {
  if (value === undefined || value === null) return Number.NaN
  if (typeof value === "number") return value
  if (typeof value !== "string") return Number.NaN
  const cleaned = value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim()
  if (!cleaned) return Number.NaN
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : Number.NaN
}

export async function generateInvoiceDocument(order: any, normalizedItems: any[], m_payment_id: string, courseInstructor: string | null = null, bankingDetails: Record<string, string> | null = null) {
  const isManual = bankingDetails !== null
  const itemsSum = normalizedItems.reduce((sum: number, item: any) => sum + Number(item.line_total || 0), 0)
    // 2) PDF Generation
    const pdf = await PDFDocument.create()
    let currentPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    let pageNum = 1
    const left = 40
    const right = PAGE_WIDTH - 40

    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)

    // Helper functions
    const drawText = (text: string, x: number, yPos: number, size = 12, bold = false, color = rgb(0.1, 0.1, 0.15), page = currentPage) => {
      page.drawText(sanitizeWinAnsi(text), { x, y: PAGE_HEIGHT - yPos, size, font: bold ? fontBold : font, color })
    }
    const drawLine = (x1: number, y1: number, x2: number, y2: number, page = currentPage) => {
      page.drawLine({ start: { x: x1, y: PAGE_HEIGHT - y1 }, end: { x: x2, y: PAGE_HEIGHT - y2 }, thickness: 1, color: rgb(0.9, 0.92, 0.95) })
    }
    const drawRightText = (text: string, x: number, yPos: number, size = 12, bold = false, color = rgb(0.1, 0.1, 0.15), page = currentPage) => {
      const textWidth = (bold ? fontBold : font).widthOfTextAtSize(sanitizeWinAnsi(text), size)
      page.drawText(sanitizeWinAnsi(text), { x: x - textWidth, y: PAGE_HEIGHT - yPos, size, font: bold ? fontBold : font, color })
    }

    const wrapText = (value: string, width: number, size = 10) => {
      const lines: string[] = []
      let line = ""
      for (const word of sanitizeWinAnsi(value).split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate
          continue
        }
        if (line) lines.push(line)
        line = ""
        // Split only a single word that is wider than the available column.
        for (const char of word) {
          if (font.widthOfTextAtSize(line + char, size) > width && line) {
            lines.push(line)
            line = ""
          }
          line += char
        }
      }
      if (line) lines.push(line.trimEnd())
      return lines.length ? lines : ["-"]
    }

    // Function to add a new page
    const addNewPage = () => {
      currentPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
      pageNum++
      return 20 // Return starting Y position for new page
    }

    // Function to check if we need a new page
    const checkPageBreak = (currentY: number, neededSpace: number) => {
      if (currentY + neededSpace > PAGE_HEIGHT - FOOTER_HEIGHT) {
        return addNewPage()
      }
      return currentY
    }

    let y = 20

    // Add Logo (only on first page)
    let logoHeight = 0
    try {
      const logoRes = await fetch(LOGO_URL, { signal: AbortSignal.timeout(4000) })
      if (logoRes.ok) {
        const logoBuf = await logoRes.arrayBuffer()
        const logoImg = await pdf.embedPng(logoBuf).catch(() => pdf.embedJpg(logoBuf))
        if (logoImg) {
          const logoW = 140
          logoHeight = (logoImg.height / logoImg.width) * logoW
          currentPage.drawImage(logoImg, { x: right - logoW, y: PAGE_HEIGHT - y - logoHeight, width: logoW, height: logoHeight })
        }
      }
    } catch (e) {}

    // Header Details (first page only)
    y = Math.max(20, logoHeight > 0 ? logoHeight + 10 : 20)
    drawText(isManual ? "INVOICE" : "RECEIPT", left, y, 24, true)
    y += 26
    drawText(`${isManual ? "Invoice" : "Receipt"} #: ${m_payment_id}`, left, y, 10, false, rgb(0.35, 0.38, 0.45))
    y += 16
    drawText(`Date: ${new Date(order.created_at).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Johannesburg' })}`, left, y, 10, false, rgb(0.35, 0.38, 0.45))
    y += 20

    drawLine(left, y, right, y)
    y += 22

    // Customer Info (first page only)
    drawText("Customer", left, y, 12, true)
    if (!isManual) drawText("Fulfillment", right - 200, y, 12, true)
    y += 18
    const buyerName = order.buyer_name || order.customer_name || "-"
    const buyerEmail = order.buyer_email || order.customer_email || "-"
    const buyerPhone = order.contact_phone || order.buyer_phone || order.customer_phone || ""
    const fulfillment = order.fulfillment_method || order.delivery_method || order.fulfillment_type || order.shipping_method || "-"
    if (isManual) {
      const detailY = y;
      for (const detail of [buyerName, buyerEmail === "-" ? "" : buyerEmail, buyerPhone].filter(Boolean)) {
        for (const line of wrapText(detail, right - left - 220, 10)) {
          drawText(line, left, y, 10)
          y += 14
        }
      }
      // Address matches the Store's current Terms page; contacts match this
      // existing invoice footer. Server overrides allow confirmed changes.
      let businessY = detailY - 18;
      drawText("BLOM Cosmetics", right - 200, businessY, 11, true)
      businessY += 17;
      const businessDetails = [
        ...(process.env.BLOM_BUSINESS_ADDRESS ? process.env.BLOM_BUSINESS_ADDRESS.split(/\r?\n/)
          : ["34 Horingbek Street", "Randfontein, 1759, South Africa"]),
        process.env.BLOM_BUSINESS_PHONE || "+27 79 548 3317",
        process.env.BLOM_BUSINESS_EMAIL || "shopblomcosmetics@gmail.com",
      ];
      for (const detail of businessDetails) {
        for (const line of wrapText(detail, 200, 9)) {
          drawText(line, right - 200, businessY, 9);
          businessY += 13;
        }
      }
      y = Math.max(y, businessY);
    } else {
      drawText(buyerName, left, y, 11)
    }

    if (isManual) {
      // Manual invoices have customer details only; no shipping or fulfilment.
    } else if (courseInstructor) {
      // In-person course: split "Name - Address" into two lines
      const dashIdx = courseInstructor.indexOf(" - ")
      const instructorName = dashIdx !== -1 ? courseInstructor.slice(0, dashIdx) : courseInstructor
      const instructorAddr = dashIdx !== -1 ? courseInstructor.slice(dashIdx + 3) : ""
      drawText(instructorName, right - 200, y, 11, true)
      y += 16
      drawText(buyerEmail, left, y, 10, false, rgb(0.4, 0.45, 0.52))
      if (instructorAddr) drawText(instructorAddr, right - 200, y, 10, false, rgb(0.4, 0.45, 0.52))
      y += 16
      drawText(buyerPhone, left, y, 10, false, rgb(0.4, 0.45, 0.52))
    } else {
      drawText(String(fulfillment || "-").toUpperCase(), right - 200, y, 11)
      y += 16
      drawText(buyerEmail, left, y, 10, false, rgb(0.4, 0.45, 0.52))
      if (order.collection_location) drawText(String(order.collection_location), right - 200, y, 10, false, rgb(0.4, 0.45, 0.52))
      y += 16
      drawText(buyerPhone, left, y, 10, false, rgb(0.4, 0.45, 0.52))

      const addrRaw = order.shipping_address ?? order.delivery_address ?? order.delivery_address_json
      const addrObj = safeParseJson(addrRaw) || addrRaw
      if (addrObj && String(fulfillment).toLowerCase().includes("delivery")) {
        const addr = addrObj
        const addrLines = [
          addr.line1 || addr.street_address,
          [addr.city, addr.postal_code || addr.code].filter(Boolean).join(' '),
          [addr.province, addr.country].filter(Boolean).join(', ')
        ].filter(Boolean)
        let addrY = y
        addrLines.forEach((line: string) => {
          drawText(line, right - 200, addrY, 9, false, rgb(0.4, 0.45, 0.52)); addrY += 13
        })
        y = Math.max(y, addrY + 4)
      }
    }
    y += 16
    drawLine(left, y, right, y)
    y += 22

    // Items Table Header
    drawText("Item", left, y, 11, true)
    drawRightText("Qty", right - 150, y, 11, true)
    drawRightText("Unit", right - 90, y, 11, true)
    drawRightText("Total", right - 20, y, 11, true)
    y += 12
    drawLine(left, y, right, y)
    y += 16

    // Items Table with Pagination
    normalizedItems.forEach((it: any) => {
      const manualLines = isManual ? wrapText(it.name || it.product_name || it.sku || "-", right - left - 210) : []
      const rowHeight = isManual ? Math.max(ITEM_ROW_HEIGHT, manualLines.length * 13 + 6) : ITEM_ROW_HEIGHT
      // Check if we need a new page before drawing the item
      y = checkPageBreak(y, rowHeight + 33)

      // If we're on a new page, redraw the table header
      if (pageNum > 1 && y === 20) {
        drawText("Item", left, y, 11, true)
        drawRightText("Qty", right - 150, y, 11, true)
        drawRightText("Unit", right - 90, y, 11, true)
        drawRightText("Total", right - 20, y, 11, true)
        y += 12
        drawLine(left, y, right, y)
        y += 16
      }

      const name = it.name || it.sku || "-"
      const variant = it.variant ? ` • ${it.variant}` : ""
      const qty = Number(it.quantity || 0)
      const unit = Number(it.unit_price || 0)
      const lineTotal = Number(it.line_total || 0)

      // Truncate long product names to fit on one line
      const maxNameWidth = right - 180
      let displayName = sanitizeWinAnsi(name + variant)
      const nameWidth = font.widthOfTextAtSize(displayName, 10)
      if (nameWidth > maxNameWidth) {
        // Truncate and add ellipsis
        let truncated = displayName
        while (font.widthOfTextAtSize(truncated + "...", 10) > maxNameWidth && truncated.length > 0) {
          truncated = truncated.slice(0, -1)
        }
        displayName = truncated + "..."
      }

      if (isManual) manualLines.forEach((line, index) => drawText(line, left, y + index * 13, 10))
      else drawText(displayName, left, y, 10)
      drawRightText(String(qty), right - 150, y, 10)
      drawRightText(money(unit), right - 90, y, 10)
      drawRightText(money(lineTotal), right - 20, y, 10)
      y += rowHeight
    })

    // Ensure we have enough space for totals section
    y = checkPageBreak(y, FOOTER_HEIGHT)

    // If we moved to a new page, add a separator line
    if (pageNum > 1 && y === 20) {
      y = 40
    }

    // Calculate totals — only use explicit DB values, never infer discount
    const shippingAmount = toNumberLoose(order.shipping_cents ?? 0) / 100
    const subtotalAmount = order.subtotal_cents != null ? toNumberLoose(order.subtotal_cents) / 100 : itemsSum
    const discountAmount = toNumberLoose(order.discount_cents ?? 0) / 100
    const taxAmount = toNumberLoose(order.tax_cents ?? order.vat_cents ?? 0) / 100

    if (normalizedItems.length === 1) {
      const only = normalizedItems[0]
      const paidSubtotal = Number.isFinite(subtotalAmount) && subtotalAmount > 0 ? subtotalAmount : 0
      const qty = Number(only.quantity || 0) || 1
      const unitLooksMissing = !(Number.isFinite(only.unit_price) && only.unit_price > 0)
      const lineLooksMissing = !(Number.isFinite(only.line_total) && only.line_total > 0)
      const looksInconsistent = Math.abs((only.line_total || 0) - paidSubtotal) > 0.01
      if (paidSubtotal > 0 && (unitLooksMissing || lineLooksMissing || looksInconsistent) && (order.order_kind === "course" || order.order_kind == null)) {
        only.unit_price = paidSubtotal / qty
        only.line_total = paidSubtotal
      }
    }

    // Only show discount line when there is a real explicit discount
    const showDiscount = discountAmount > 0.0001

    // Shipping line
    const isFreeShipping = !isManual && subtotalAmount >= FREE_SHIPPING_THRESHOLD && shippingAmount === 0
    if (isFreeShipping) {
      y = checkPageBreak(y, ITEM_ROW_HEIGHT)
      drawText("FREE SHIPPING - Order over " + FREE_SHIPPING_THRESHOLD_LABEL, left, y, 10)
      drawRightText("R 0.00", right - 20, y, 10)
      y += ITEM_ROW_HEIGHT
    } else if (shippingAmount > 0) {
      y = checkPageBreak(y, ITEM_ROW_HEIGHT)
      drawText("Shipping & Handling", left, y, 10)
      drawRightText("1", right - 150, y, 10)
      drawRightText(money(shippingAmount), right - 90, y, 10)
      drawRightText(money(shippingAmount), right - 20, y, 10)
      y += ITEM_ROW_HEIGHT
    }

    // Discount line — only when there is an explicit discount
    if (showDiscount) {
      y = checkPageBreak(y, ITEM_ROW_HEIGHT)
      const label = order.coupon_code ? `Coupon Discount (${order.coupon_code})` : "Coupon Discount"
      drawText(label, left, y, 10, false, rgb(0, 0.5, 0.2))
      drawRightText("-" + money(discountAmount), right - 20, y, 10, false, rgb(0, 0.5, 0.2))
      y += ITEM_ROW_HEIGHT
    }

    if (taxAmount > 0.0001) {
      y = checkPageBreak(y, ITEM_ROW_HEIGHT)
      drawText("Tax", left, y, 10)
      drawRightText(money(taxAmount), right - 20, y, 10)
      y += ITEM_ROW_HEIGHT
    }

    y += 10
    y = checkPageBreak(y, 55)
    drawLine(left, y, right, y)
    y += 20

    // Prefer stored order.total (what was paid); otherwise use calculated total
    const calculatedTotal = Math.max(0, subtotalAmount + shippingAmount - discountAmount + taxAmount)
    const totalCentsRaw = toNumberLoose(order.total_cents ?? Number.NaN)
    const totalRandsRaw = toNumberLoose(order.total ?? Number.NaN)
    const finalTotal =
      Number.isFinite(totalCentsRaw) && totalCentsRaw > 0
        ? totalCentsRaw / 100
        : Number.isFinite(totalRandsRaw) && totalRandsRaw > 0
          ? totalRandsRaw
          : calculatedTotal

    // Total row
    const totalRuleY = y - 2
    if (!isManual) drawLine(right - 250, totalRuleY, right, totalRuleY)
    drawText("Total", right - 140, y, 13, true)
    drawRightText(money(finalTotal), right - 20, y, 13, true)

    // Footer (only on last page)
    y += 35
    y = checkPageBreak(y, 40)
    drawLine(left, y, right, y)
    y += 18
    drawText("Thank you for your purchase!", left, y, 10, false, rgb(0.35, 0.38, 0.45))
    y += 14
    drawText("Questions? Contact us: shopblomcosmetics@gmail.com | +27 79 548 3317", left, y, 9, false, rgb(0.4, 0.45, 0.52))

    if (bankingDetails) {
      // Older invoices saved "Account holder"; blank fields (e.g. no account type) are omitted.
      const bankLines = ([
        ["Account name", bankingDetails.account_holder],
        ["Bank", bankingDetails.bank_name],
        ["Account number", bankingDetails.account_number],
        ["Account type", bankingDetails.account_type],
        ["Branch code", bankingDetails.branch_code],
      ] as [string, string | undefined][]).filter(([, value]) => value?.trim())
        .flatMap(([label, value]) => wrapText(`${label}: ${value}`, right - left, 10))
      const paymentLines = wrapText(`Please use ${m_payment_id} as your payment reference when making payment.`, right - left - 20, 10)
      y += 30
      y = checkPageBreak(y, 43 + (bankLines.length + paymentLines.length) * 15)
      drawText(bankingDetails.is_placeholder === "true" ? "BLOM banking details - PLACEHOLDERS" : "BLOM Cosmetics banking details", left, y, 12, true)
      y += 22
      bankLines.forEach(line => { drawText(line, left, y, 10); y += 15 })
      y += 15
      paymentLines.forEach(line => { drawText(line, left, y, 10, true, rgb(0, 0, 0)); y += 15 })
    }

    // Add page numbers to all pages
    const pages = pdf.getPages()
    pages.forEach((page, index) => {
      const pageY = 20
      const pageX = PAGE_WIDTH / 2
      page.drawText(`Page ${index + 1}`, {
        x: pageX - (font.widthOfTextAtSize(`Page ${index + 1}`, 8) / 2),
        y: pageY,
        size: 8,
        font,
        color: rgb(0.5, 0.5, 0.5)
      })
    })

    const pdfBytes = await pdf.save()
    return pdfBytes
}
