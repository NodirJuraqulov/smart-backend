import type { Knex } from "knex";
import { describe, expect, it, vi } from "vitest";
import { up } from "../../migrations/20260821090000_add_led_settings_to_organizations";

describe("LED settings migration", () => {
  it("org_id=1 ni amaldagi LED manzili bilan backfill qiladi", async () => {
    const stringNullable = vi.fn();
    const integerDefault = vi.fn();
    const table = {
      string: vi.fn(() => ({ nullable: stringNullable })),
      integer: vi.fn(() => ({
        unsigned: () => ({
          nullable: () => ({ defaultTo: integerDefault }),
        }),
      })),
    };
    const alterTable = vi.fn(async (_name: string, callback: (builder: typeof table) => void) => {
      callback(table);
    });
    const updateOtherOrganizations = vi.fn().mockResolvedValue(0);
    const updatePrimaryOrganization = vi.fn().mockResolvedValue(1);
    const whereNot = vi.fn(() => ({ update: updateOtherOrganizations }));
    const where = vi.fn(() => ({ update: updatePrimaryOrganization }));
    const knex = Object.assign(
      vi.fn(() => ({ whereNot, where })),
      { schema: { alterTable } }
    ) as unknown as Knex;

    await up(knex);

    expect(table.string).toHaveBeenCalledWith("led_host", 255);
    expect(table.integer).toHaveBeenCalledWith("led_port");
    expect(integerDefault).toHaveBeenCalledWith(10000);
    expect(whereNot).toHaveBeenCalledWith({ id: 1 });
    expect(updateOtherOrganizations).toHaveBeenCalledWith({ led_host: null, led_port: null });
    expect(where).toHaveBeenCalledWith({ id: 1 });
    expect(updatePrimaryOrganization).toHaveBeenCalledWith({
      led_host: "192.168.1.157",
      led_port: 10000,
    });
  });
});
