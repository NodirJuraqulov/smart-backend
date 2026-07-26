import { printer as ThermalPrinter, types as PrinterTypes } from "node-thermal-printer";

const PRINTER_PORT = 9100;
const PRINTER_TIMEOUT_MS = 5000;

export interface ReceiptData {
  orgName: string;
  plateNumber: string;
  enteredAt: Date;
  exitedAt: Date;
  durationMinutes: number;
  amount: number;
  paymentMethod: "cash" | "online";
  issuedAt: Date;
}

function formatDateTime(date: Date): string {
  return date.toLocaleString("uz-UZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(durationMinutes: number): string {
  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;
  return `${hours} soat ${minutes} daqiqa`;
}

function formatPaymentMethod(paymentMethod: "cash" | "online"): string {
  return paymentMethod === "cash" ? "Naqd" : "Онлайн";
}

function buildReceipt(printer: ThermalPrinter, data: ReceiptData): void {
  printer.alignCenter();
  printer.setTextDoubleHeight();
  printer.bold(true);
  printer.println(data.orgName);
  printer.bold(false);
  printer.setTextNormal();
  printer.drawLine();

  printer.alignLeft();
  printer.println(`Nomer: ${data.plateNumber}`);
  printer.println(`Kirish: ${formatDateTime(data.enteredAt)}`);
  printer.println(`Chiqish: ${formatDateTime(data.exitedAt)}`);
  printer.println(`Davomiylik: ${formatDuration(data.durationMinutes)}`);
  printer.println(`To'lov turi: ${formatPaymentMethod(data.paymentMethod)}`);
  printer.drawLine();

  printer.alignCenter();
  printer.setTextDoubleHeight();
  printer.bold(true);
  printer.println(`${data.amount} so'm`);
  printer.bold(false);
  printer.setTextNormal();
  printer.drawLine();

  printer.println(formatDateTime(data.issuedAt));
  printer.newLine();
  printer.cut();
}

export async function printReceipt(
  printerIp: string | null | undefined,
  receiptData: ReceiptData
): Promise<boolean> {
  if (!printerIp) {
    return false;
  }

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${printerIp}:${PRINTER_PORT}`,
    width: 48,
    options: { timeout: PRINTER_TIMEOUT_MS },
  });

  try {
    buildReceipt(printer, receiptData);
    await printer.execute();
    console.log(`Chek chop etildi: ${printerIp}`);
    return true;
  } catch (err) {
    console.error(`Chek chop etib bo'lmadi: ${printerIp}`, err);
    return false;
  }
}
