import * as h from "ivi-html";
import { query, queryAll, q } from "../src/query";
import { VNodeWrapper } from "../src/vdom";
import { expect } from "iko";

describe("query", () => {
  const tree = new VNodeWrapper(h.div().children(h.span(), h.span()), null, {});

  describe("one", () => {
    it("div", () => {
      const result = query(tree, q.div().match);
      expect(result).toBeEqual(null);
    });

    it("span", () => {
      const result = query(tree, q.span().match);
      expect(result!.getTagName()).toBeEqual("span");
    });
  });

  describe("many", () => {
    it("div", () => {
      const result = queryAll(tree, q.div().match);
      expect(result.length).toBeEqual(0);
    });

    it("span", () => {
      const result = queryAll(tree, q.span().match);
      expect(result.length).toBeEqual(2);
    });
  });
});
