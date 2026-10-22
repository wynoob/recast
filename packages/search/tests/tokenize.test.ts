import { describe, expect, it } from "vitest";
import {
  SearchValidationError,
  escapeLikePattern,
  normalize,
  safeFtsQuery,
  tokenizeForFts,
} from "../src/index.js";

describe("normalize and tokenize", () => {
  it("对索引副本做 NFKC，并将英文转小写", () => {
    expect(normalize("Ｄｍａｌｌ　１２３　商户  ABC")).toBe("dmall 123 商户 abc");
  });

  it("中文生成重叠二字，英文按词", () => {
    const tokens = tokenizeForFts("Dmall 商家销售日报");
    expect(tokens.map((token) => token.value)).toEqual([
      "dmall",
      "商家",
      "家销",
      "销售",
      "售日",
      "日报",
    ]);
    expect(tokens.every((token) => token.kind === "latin_word" || token.kind === "cjk_bigram")).toBe(
      true,
    );
  });

  it("单字标记为受控单字 token", () => {
    expect(tokenizeForFts("店")).toEqual([{ kind: "cjk_single", value: "店" }]);
  });

  it("FTS 用户输入只进入引号 token，不成为查询语法", () => {
    const query = safeFtsQuery('Dmall OR "商家" AND NEAR(店铺, 2)');
    expect(query.mode).toBe("fts");
    expect(query.ftsExpression).toBe(
      '"dmall" AND "or" AND "商家" AND "and" AND "near" AND "店铺" AND "2"',
    );
    expect(query.ftsExpression).not.toContain("NEAR(");
  });

  it("单字与混合查询走 LIKE，并转义通配符", () => {
    expect(safeFtsQuery("店")).toMatchObject({
      mode: "like",
      ftsExpression: null,
      likeTerms: ["店"],
    });
    expect(safeFtsQuery("100%_店")).toMatchObject({
      mode: "mixed",
      ftsTokens: ["100"],
      likeTerms: ["店"],
    });
    expect(escapeLikePattern("50%_\\")).toBe("50\\%\\_\\\\");
  });

  it("SQL/FTS 符号不会拼进查询语法，纯符号查询被拒绝", () => {
    const query = safeFtsQuery("销售'; DROP TABLE chunk_search; --");
    expect(query.ftsExpression).not.toContain("'");
    expect(query.ftsExpression).not.toContain(";");
    expect(query.ftsExpression).not.toContain("--");
    expect(query.ftsTokens).toEqual(["销售", "drop", "table", "chunk", "search"]);

    expect(() => safeFtsQuery("%_%")).toThrow(SearchValidationError);
  });
});
