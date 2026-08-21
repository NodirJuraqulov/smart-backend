import type { Knex } from "knex";
import { describe, expect, it, vi } from "vitest";
import { up } from "../../migrations/20260821100000_add_telegram_settings_to_organizations";
import { decryptSecret } from "@/utils/encryption";

describe("Telegram settings migration", () => {
  it("org_id=1 uchun shifrlangan token va boshlang'ich Chat ID yozadi", async () => {
    const stringNullable = vi.fn();
    const textNullable = vi.fn();
    const table = {
      string: vi.fn(() => ({ nullable: stringNullable })),
      text: vi.fn(() => ({ nullable: textNullable })),
    };
    const alterTable = vi.fn(async (_name: string, callback: (builder: typeof table) => void) => {
      callback(table);
    });
    const update = vi.fn().mockResolvedValue(1);
    const where = vi.fn(() => ({ update }));
    const knex = Object.assign(vi.fn(() => ({ where })), {
      schema: { alterTable, hasColumn: vi.fn().mockResolvedValue(false) },
    }) as unknown as Knex;

    await up(knex);

    expect(table.string).toHaveBeenCalledWith("telegram_bot_token", 500);
    expect(table.text).toHaveBeenCalledWith("telegram_chat_ids");
    expect(where).toHaveBeenCalledWith({ id: 1 });
    const values = update.mock.calls[0]?.[0] as {
      telegram_bot_token: string;
      telegram_chat_ids: string;
    };
    expect(values.telegram_bot_token).not.toContain("AAFuHJQ");
    expect(decryptSecret(values.telegram_bot_token)).toBe(
      "8541898557:AAFuHJQ529EDA7r6L6baH1j5V75U3g8fDLo"
    );
    expect(values.telegram_chat_ids).toBe('["1652032889"]');
  });
});
