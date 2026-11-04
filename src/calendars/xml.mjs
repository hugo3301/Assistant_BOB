import { SaxesParser } from "saxes";
import { requireThat } from "../errors.mjs";
export const xmlEscape = (text) =>
  String(text).replace(
    /[&<>"']/gu,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );
export function parseXml(source) {
  requireThat(
    typeof source === "string" &&
      source.length <= 2000000 &&
      !/<!DOCTYPE|<!ENTITY/iu.test(source),
    "CALENDAR_XML",
    "Календарь вернул неподдерживаемый XML.",
  );
  const root = { name: "root", children: [], text: "" },
    stack = [root];
  let nodes = 0;
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on("opentag", (tag) => {
      if (++nodes > 20000 || stack.length > 40) throw Error("XML bounds");
      const node = { name: tag.local, uri: tag.uri, children: [], text: "" };
      stack.at(-1).children.push(node);
      stack.push(node);
    });
    parser.on("text", (text) => (stack.at(-1).text += text));
    parser.on("cdata", (text) => (stack.at(-1).text += text));
    parser.on("closetag", () => stack.pop());
    parser.write(source).close();
  } catch {
    requireThat(
      false,
      "CALENDAR_XML",
      "Не удалось прочитать ответ календаря. Данные сохранены.",
    );
  }
  return root;
}
export const child = (node, name) =>
  node?.children.find((value) => value.name === name);
export function descendants(node, name) {
  return (node?.children ?? []).flatMap((value) => [
    ...(value.name === name ? [value] : []),
    ...descendants(value, name),
  ]);
}
export const textAt = (node, name) => descendants(node, name)[0]?.text ?? "";
export function davResponses(source) {
  return descendants(parseXml(source), "response").map((node) => {
    const successful = node.children.filter(
      (value) =>
        value.name === "propstat" &&
        /\s200(?:\s|$)/u.test(textAt(value, "status")),
    );
    return {
      href: child(node, "href")?.text ?? "",
      props: successful.flatMap(
        (value) => child(value, "prop")?.children ?? [],
      ),
      status: child(node, "status")?.text ?? "",
    };
  });
}
