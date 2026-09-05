import { db } from "@/config/db";
import { ApiError } from "@/utils/ApiError";
import { PaymentTerminal } from "./PaymentTerminal.interface";
import { VendotekVTK } from "./VendotekVTK";

export interface CardTerminalSettings {
  id: number;
  card_terminal_enabled: boolean;
  card_terminal_ip: string | null;
  card_terminal_port: number | null;
}

export interface PaymentTerminalLease {
  terminal: PaymentTerminal;
  bindOperation(operationNumber: string): void;
  release(): void;
}

type TerminalFactory = (settings: CardTerminalSettings) => PaymentTerminal;

export class PaymentTerminalManager {
  private readonly terminals = new Map<number, PaymentTerminal>();
  private readonly busyOrganizations = new Set<number>();
  private readonly pendingReloads = new Set<number>();
  private readonly activeLeases = new Map<number, { token: symbol; operationNumber: string | null }>();

  constructor(
    private readonly terminalFactory: TerminalFactory = (settings) =>
      new VendotekVTK({
        orgId: settings.id,
        host: settings.card_terminal_ip!,
        port: settings.card_terminal_port ?? 62801,
        updateKeepaliveInterval: async (orgId, seconds) => {
          await db("tb_organizations")
            .where({ id: orgId })
            .update({ card_terminal_keepalive_interval_seconds: seconds });
        },
      })
  ) {}

  async start(): Promise<void> {
    try {
      await this.markOrphanedOperations();
    } catch (error) {
      console.error("VTK_ORPHAN_RECOVERY_FAILED", error);
    }
    const organizations = await db<CardTerminalSettings>("tb_organizations")
      .select("id", "card_terminal_enabled", "card_terminal_ip", "card_terminal_port")
      .where({ card_terminal_enabled: true });
    for (const settings of organizations) {
      try {
        const terminal = this.createTerminal(settings);
        this.terminals.set(settings.id, terminal);
        void terminal.connect().catch((error) => {
          console.error(`VTK_START_FAILED org_id=${settings.id}`, error);
        });
      } catch (error) {
        console.error(`VTK_START_FAILED org_id=${settings.id}`, error);
      }
    }
  }

  async stop(): Promise<void> {
    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    this.busyOrganizations.clear();
    this.pendingReloads.clear();
    this.activeLeases.clear();
    await Promise.allSettled(terminals.map((terminal) => terminal.disconnect()));
  }

  async reloadTerminal(orgId: number): Promise<void> {
    if (this.busyOrganizations.has(orgId)) {
      this.pendingReloads.add(orgId);
      return;
    }
    const current = this.terminals.get(orgId);
    this.terminals.delete(orgId);
    this.busyOrganizations.delete(orgId);
    if (current) await current.disconnect();
    const settings = await this.findSettings(orgId);
    if (!settings.card_terminal_enabled) return;
    const terminal = this.createTerminal(settings);
    this.terminals.set(orgId, terminal);
    void terminal.connect().catch((error) => {
      console.error(`VTK_RELOAD_FAILED org_id=${orgId}`, error);
    });
  }

  async acquire(orgId: number): Promise<PaymentTerminalLease> {
    return this.acquireConfigured(await this.findSettings(orgId));
  }

  acquireConfigured(settings: CardTerminalSettings): PaymentTerminalLease {
    const orgId = settings.id;
    if (!settings.card_terminal_enabled) {
      throw new ApiError("Karta terminali bu filialda yoqilmagan", 400);
    }
    if (this.busyOrganizations.has(orgId)) {
      throw new ApiError("Terminal band, biroz kutib qayta urining", 409);
    }
    let terminal = this.terminals.get(orgId);
    if (!terminal) {
      terminal = this.createTerminal(settings);
      this.terminals.set(orgId, terminal);
    }
    this.busyOrganizations.add(orgId);
    const token = Symbol(String(orgId));
    this.activeLeases.set(orgId, { token, operationNumber: null });
    let released = false;
    return {
      terminal,
      bindOperation: (operationNumber) => {
        const active = this.activeLeases.get(orgId);
        if (active?.token === token) active.operationNumber = operationNumber;
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.activeLeases.get(orgId)?.token !== token) return;
        this.activeLeases.delete(orgId);
        this.busyOrganizations.delete(orgId);
        if (this.pendingReloads.delete(orgId)) {
          void this.reloadTerminal(orgId).catch((error) => {
            console.error(`VTK_DEFERRED_RELOAD_FAILED org_id=${orgId}`, error);
          });
        }
      },
    };
  }

  isBusy(orgId: number): boolean {
    return this.busyOrganizations.has(orgId);
  }

  async abortPendingPayment(orgId: number, operationNumber: string): Promise<void> {
    const active = this.activeLeases.get(orgId);
    if (!active || active.operationNumber !== operationNumber) return;
    const terminal = this.terminals.get(orgId);
    this.activeLeases.delete(orgId);
    try {
      await terminal?.abortPendingPayment(operationNumber);
    } finally {
      this.busyOrganizations.delete(orgId);
      if (this.pendingReloads.delete(orgId)) {
        void this.reloadTerminal(orgId).catch((error) => {
          console.error(`VTK_DEFERRED_RELOAD_FAILED org_id=${orgId}`, error);
        });
      }
    }
  }

  hasTerminal(orgId: number): boolean {
    return this.terminals.has(orgId);
  }

  private async findSettings(orgId: number): Promise<CardTerminalSettings> {
    const settings = await db<CardTerminalSettings>("tb_organizations")
      .select("id", "card_terminal_enabled", "card_terminal_ip", "card_terminal_port")
      .where({ id: orgId })
      .first();
    if (!settings) throw new ApiError("Stoyanka topilmadi", 404);
    return settings;
  }

  private createTerminal(settings: CardTerminalSettings): PaymentTerminal {
    if (!settings.card_terminal_ip) {
      throw new ApiError("Karta terminali IP manzili sozlanmagan", 400);
    }
    return this.terminalFactory(settings);
  }

  private async markOrphanedOperations(): Promise<void> {
    const cutoff = new Date(Date.now() - 2 * 60_000);
    const operations = await db("payment_terminal_operations")
      .select("id", "org_id", "session_id", "operation_number", "status")
      .whereIn("status", ["PENDING", "APPROVED"])
      .andWhere("created_at", "<", cutoff);
    for (const operation of operations) {
      const updated = await db("payment_terminal_operations")
        .where({ id: operation.id, status: operation.status })
        .update({
          status: "ORPHANED",
          error_message: "Backend restartidan keyin terminal yoki bank holatini qo'lda tekshirish kerak",
          updated_at: db.fn.now(),
        });
      if (!updated) continue;
      await db("tb_activity_logs").insert({
        actor_id: null,
        action: "payment_terminal.orphaned",
        target_type: "session",
        target_id: operation.session_id,
        details: JSON.stringify({
          orgId: operation.org_id,
          operationNumber: operation.operation_number,
          previousStatus: operation.status,
        }),
      });
      console.error(
        `ORPHANED CARD OPERATION topildi backend restart paytida: operation=${operation.operation_number}, org=${operation.org_id}, session=${operation.session_id ?? "null"} — TERMINAL/BANK HOLATINI QO'LDA TEKSHIRING`
      );
    }
  }
}

export const paymentTerminalManager = new PaymentTerminalManager();
