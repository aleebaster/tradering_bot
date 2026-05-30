export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, service: "панель", scannerRunsLocally: true, message: "Сканер і сигнальний рушій працюють локально на Windows-хості." });
}
