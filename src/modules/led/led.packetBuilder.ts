import { H, W, Y_START } from "./led.renderer";

export const PREFIX_HEX = "01011003000001000000000000000000000000000000000000";
export const ITEM_TEMPLATE_HEX = "01f802000001000000003f001600020063ff08ff63ff08ff";
export const PREFIX = Buffer.from(PREFIX_HEX, "hex");
export const ITEM_TEMPLATE = Buffer.from(ITEM_TEMPLATE_HEX, "hex");

const PLANE_SIZE = 352;
const PLANE_COUNT = 4;
const CHUNK_SIZE = 512;
const PACKET_SIZE = 536;
const HEADER_SIZE = 20;
const TERMINATOR = Buffer.from([0x00, 0x00, 0x0d, 0x0a]);
const HEADER_PREFIX = Buffer.from([0x55, 0xaa, 0x00, 0x00, 0x01, 0x00, 0x00, 0xda]);

export function buildLogicalPayload(plane1: Buffer): Buffer {
  if (plane1.length !== PLANE_SIZE) {
    throw new RangeError(`LED plane1 ${PLANE_SIZE} bayt bo'lishi kerak`);
  }
  const item = Buffer.from(ITEM_TEMPLATE);
  const itemLength = item.length + PLANE_SIZE * PLANE_COUNT;
  item.writeUInt32LE(itemLength, 1);
  item.writeUInt16LE(0, 6);
  item.writeUInt16LE(Y_START, 8);
  item.writeUInt16LE(W - 1, 10);
  item.writeUInt16LE(Y_START + H - 1, 12);
  const blankPlane = Buffer.alloc(PLANE_SIZE, 0xff);
  return Buffer.concat([PREFIX, item, plane1, blankPlane, blankPlane, blankPlane]);
}

export function buildPackets(logical: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0, index = 0; offset < logical.length; offset += CHUNK_SIZE, index += 1) {
    const chunk = logical.subarray(offset, Math.min(offset + CHUNK_SIZE, logical.length));
    const packet = Buffer.alloc(PACKET_SIZE);
    HEADER_PREFIX.copy(packet, 0);
    packet.writeUInt16LE(index, 8);
    packet.writeUInt32LE(logical.length, 10);
    packet.writeUInt32LE(chunk.length, 16);
    chunk.copy(packet, HEADER_SIZE);
    TERMINATOR.copy(packet, HEADER_SIZE + chunk.length);
    packets.push(packet);
  }
  return packets;
}
