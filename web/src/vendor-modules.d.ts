/**
 * Ambient types for the third-party modules used by the CodeEditor.
 * These packages ship no type declarations, so we declare the small surface we use.
 */

declare module "highlight.js/lib/core" {
  interface HLJSApi {
    registerLanguage(name: string, language: unknown): void;
    getLanguage(name: string): unknown;
    listLanguages(): string[];
    highlightAuto(code: string, languageSubset?: string[]): { language?: string; value: string };
    highlightElement(element: Element): void;
    [key: string]: unknown;
  }
  const hljs: HLJSApi;
  export default hljs;
}

declare module "highlight.js/lib/languages/*" {
  const language: unknown;
  export default language;
}

declare module "@webcoder49/code-input" {
  export class Plugin {
    constructor(...args: unknown[]);
  }
  export class Template {
    constructor(...args: unknown[]);
  }
  export class CodeInput {
    static usedTemplates?: Record<string, unknown>;
    [key: string]: unknown;
  }
  export function registerTemplate(templateName: string, template: Template): void;
  const codeInput: {
    usedTemplates?: Record<string, unknown>;
    [key: string]: unknown;
  };
  export default codeInput;
}

declare module "@webcoder49/code-input/templates/hljs.mjs" {
  import type hljs from "highlight.js/lib/core";
  export default class HljsTemplate {
    constructor(hljs: typeof hljs, options: unknown[]);
  }
}

declare module "@webcoder49/code-input/code-input.css";