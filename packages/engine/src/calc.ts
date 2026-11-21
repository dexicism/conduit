/**
 * Safe arithmetic evaluator for the Calculator tool. A small recursive-descent
 * parser: numbers, + - * / % ^, parentheses, unary minus, and a fixed set of
 * functions. No `eval`, no identifiers beyond the allow-list.
 */

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export class CalcError extends Error {}

export function calculate(expr: string): number {
  if (expr.length > 500) throw new CalcError("Expression is too long");
  const src = expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/,(?=\d{3}\b)/g, "");
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const eat = (c: string) => {
    skip();
    if (src[i] === c) {
      i++;
      return true;
    }
    return false;
  };

  function primary(): number {
    skip();
    if (eat("(")) {
      const v = expression();
      if (!eat(")")) throw new CalcError("Missing closing parenthesis");
      return v;
    }
    if (eat("-")) return -primary();
    if (eat("+")) return primary();
    const num = /^\d+(\.\d+)?([eE][+-]?\d+)?|^\.\d+/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const ident = /^[a-z]+/i.exec(src.slice(i));
    if (ident) {
      const name = ident[0].toLowerCase();
      i += ident[0].length;
      if (name in CONSTS) return CONSTS[name]!;
      const fn = FUNCS[name];
      if (!fn) throw new CalcError(`Unknown function "${name}"`);
      if (!eat("(")) throw new CalcError(`Expected "(" after ${name}`);
      const args: number[] = [];
      if (!eat(")")) {
        do args.push(expression());
        while (eat(","));
        if (!eat(")")) throw new CalcError(`Missing ")" after ${name} arguments`);
      }
      return fn(...args);
    }
    throw new CalcError(`Unexpected "${peek() ?? "end of expression"}"`);
  }

  function power(): number {
    const base = primary();
    if (eat("^")) return base ** power(); // right-associative
    return base;
  }

  function term(): number {
    let v = power();
    for (;;) {
      if (eat("*")) v *= power();
      else if (eat("/")) {
        const d = power();
        if (d === 0) throw new CalcError("Division by zero");
        v /= d;
      } else if (eat("%")) v %= power();
      else return v;
    }
  }

  function expression(): number {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  }

  const result = expression();
  skip();
  if (i < src.length) throw new CalcError(`Unexpected "${src[i]}"`);
  if (!Number.isFinite(result)) throw new CalcError("Result is not a finite number");
  return result;
}
