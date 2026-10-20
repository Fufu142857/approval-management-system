import { describe, expect, it } from "vitest";
import { purchaseAmounts } from "../src/lib/purchase-display";
const row = (quantity: string | null, unitPrice: string | null) => ({
  name: "",
  specification: "",
  quantity,
  unit: "",
  unitPrice,
});
describe("采购输入中的精确金额预览", () => {
  it("先规范化未补零输入，按行舍入再合计", () => {
    expect(purchaseAmounts([row("0.125", "0.12"), row("0.3", "0.1")])).toEqual({
      lines: ["0.02", "0.03"],
      total: "0.05",
      overflow: false,
    });
  });
  it("缺项及键入中的无效内容不抛异常、不冒充零", () => {
    for (const value of [null, "1.", "x", "-1", "0", "1.1234"])
      expect(purchaseAmounts([row(value, "12")]).total).toBeNull();
    expect(purchaseAmounts([]).total).toBeNull();
    expect(purchaseAmounts([row("0.001", "0.01")]).total).toBe("0.00");
  });
  it("大额计算保持分位精度，合计上限单独提示", () => {
    expect(
      purchaseAmounts([row("1", "999999999999.99"), row("1", "0.01")]),
    ).toEqual({
      lines: ["999999999999.99", "0.01"],
      total: "1000000000000.00",
      overflow: true,
    });
    expect(
      purchaseAmounts([row("999999999", "999999999999.99")]).total,
    ).toBeNull();
  });
});
