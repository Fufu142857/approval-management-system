import { describe, expect, it } from "vitest";
import { reimbursementAmount } from "../src/lib/reimbursement-display";
import { reimbursementDraftSchema } from "../src/lib/reimbursement";
const row = (amount: string | null) => ({
  ...reimbursementDraftSchema.parse({ items: [{}] }).items[0],
  amount,
});
describe("报销输入精确金额预览", () => {
  it("未补零金额精确到分，不以浮点求和", () => {
    expect(reimbursementAmount([row("0.1"), row("0.2"), row("1.23")])).toEqual({
      total: "1.53",
      overflow: false,
    });
  });
  it("缺项和键入中非法内容不冒充零、不抛异常", () => {
    for (const amount of [null, "", "0", "1.", "1.001", "-1", "abc", "1e2"])
      expect(reimbursementAmount([row("0.1"), row(amount)]).total).toBeNull();
    expect(reimbursementAmount([]).total).toBeNull();
  });
  it("大额保持分位精度，合计溢出独立提示", () => {
    expect(reimbursementAmount([row("999999999999.98"), row("0.01")])).toEqual({
      total: "999999999999.99",
      overflow: false,
    });
    expect(reimbursementAmount([row("999999999999.99"), row("0.01")])).toEqual({
      total: "1000000000000.00",
      overflow: true,
    });
  });
});
