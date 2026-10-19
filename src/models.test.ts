import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, findModel, MODEL_ALIASES } from "./models.js";

describe("findModel", () => {
  it("finds a model by its exact ID", () => {
    expect(findModel("claude-haiku-4-5")?.id).toBe("claude-haiku-4-5");
  });

  it("resolves each alias to the current model of its family", () => {
    expect(findModel("opus")?.id).toBe("claude-opus-5-5");
    expect(findModel("sonnet")?.id).toBe("claude-sonnet-5-5");
    expect(findModel("haiku")?.id).toBe("claude-haiku-5-5");
  });

  it.each(["claude-haiku-4.5", "Haiku", "claude-haiku", "constructor", ""])(
    "does not recognise %j",
    (name) => {
      expect(findModel(name)).toBeUndefined();
    },
  );
});

describe("the alias table and the default", () => {
  it("point only at models the CLI knows", () => {
    for (const id of [...MODEL_ALIASES.values(), DEFAULT_MODEL_ID]) {
      expect(findModel(id), id).toBeDefined();
    }
  });
});
