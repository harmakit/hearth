import assert from "node:assert/strict";
import { test } from "node:test";
import { fitDialogSize } from "../renderer/dialog-size.mjs";

test("keeps manually enlarged dialogs inside a shorter or narrower window", () => {
  assert.deepEqual(fitDialogSize({ width: 900, height: 700 }, { width: 650, height: 450 }), { width: 622, height: 422 });
  assert.deepEqual(fitDialogSize({ width: 12, height: 20 }, { width: 660, height: 470 }), { width: 360, height: 240 });
  assert.deepEqual(fitDialogSize({ width: 1000, height: 1000 }, { width: 300, height: 229 }), { width: 272, height: 201 });
});
