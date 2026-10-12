/** 截图图片地址构造：版本参数防旧缓存，width 传了取缩略图。 */
import { describe, expect, it } from "vitest";

import { shotSrc, type SiteShot } from "@/lib/screenshots";

const shot: SiteShot = { url: "https://a.test/", captured_at: 1791792260.42, bytes: 123 };

describe("shotSrc", () => {
  it("默认取原图：带拍摄时间版本参数、不带宽度", () => {
    const src = shotSrc("a", shot);
    expect(src).toBe("/api/sites/a/screenshot?v=1791792260.42");
    expect(src).not.toContain("w=");
  });

  it("传宽度取缩略图", () => {
    expect(shotSrc("a", shot, 320)).toBe("/api/sites/a/screenshot?v=1791792260.42&w=320");
  });

  it("站点 id 做 URL 编码，防特殊字符破坏地址", () => {
    expect(shotSrc("a b/c", shot)).toBe("/api/sites/a%20b%2Fc/screenshot?v=1791792260.42");
  });
});
