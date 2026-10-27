import { describe, expect, it } from "vitest";
import { charClipBottom, containRect, FG_TABLE_OPAQUE_EDGE } from "../src/stage/charClip";

/**
 * S6b-fix2 §2：手机竖屏角色基底层按前景桌的完全不透明下沿裁切。
 * 几何基准（iPhone 13 实测）：舞台 390×664，图层容器 bottom:120 → 390×544。
 * 角色基底 master_clean 1024×1536（aspect 2/3）contain → 高受限 top:0 h:544。
 * 前景桌 fg_table_v 1024×1024（aspect 1）contain → top:77 h:390。
 * 桌沿完全不透明下沿 y = 77 + 390×0.8 = 389；角色底 544 → 裁掉 155px。
 */
describe("charClip（S6b-fix2 §2 手机竖屏角色图层按桌沿裁切）", () => {
  const CONTAINER = { width: 390, height: 544 };
  const CHAR_ASPECT = 1024 / 1536; // 2/3
  const TABLE_ASPECT = 1024 / 1024; // 1

  it("containRect：高受限（角色 2:3）时图片顶边贴容器顶", () => {
    const r = containRect(CONTAINER, CHAR_ASPECT);
    expect(r.top).toBe(0);
    expect(r.height).toBe(544);
  });

  it("containRect：宽受限（前景桌 1:1）时图片垂直居中", () => {
    const r = containRect(CONTAINER, TABLE_ASPECT);
    expect(r.top).toBe(77);
    expect(r.height).toBe(390);
  });

  it("charClipBottom：角色底边伸到桌沿下沿之下时，裁掉超出部分", () => {
    const char = containRect(CONTAINER, CHAR_ASPECT);
    const table = containRect(CONTAINER, TABLE_ASPECT);
    // 桌沿下沿 = 77 + 390×0.8 = 389；角色底 = 544；超出 155。
    expect(charClipBottom(char, table)).toBe(155);
  });

  it("charClipBottom：角色底边在桌沿下沿之上时不裁（返回 0）", () => {
    const table = containRect(CONTAINER, TABLE_ASPECT);
    const tableEdge = table.top + table.height * FG_TABLE_OPAQUE_EDGE;
    const shortChar = { top: 0, height: tableEdge - 10 };
    expect(charClipBottom(shortChar, table)).toBe(0);
  });

  it("charClipBottom：容器更高时裁切量随之变化（按矩形计算，非固定值）", () => {
    const taller = { width: 390, height: 700 };
    const char = containRect(taller, CHAR_ASPECT); // 宽受限? 390/(2/3)=585<700 → 宽受限 top=(700-585)/2=57.5 h=585
    const table = containRect(taller, TABLE_ASPECT); // top=(700-390)/2=155 h=390
    const clip = charClipBottom(char, table);
    // 桌沿下沿 = 155 + 312 = 467；角色底 = 57.5+585 = 642.5；超出 175.5 → 176。
    expect(clip).toBe(176);
  });

  it("containRect：非法输入（0 尺寸 / 非正纵横比）返回空矩形", () => {
    expect(containRect({ width: 0, height: 544 }, CHAR_ASPECT)).toEqual({ top: 0, height: 0 });
    expect(containRect(CONTAINER, 0)).toEqual({ top: 0, height: 0 });
  });
});
