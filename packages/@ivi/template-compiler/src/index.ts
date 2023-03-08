import { TemplateFlags, StateOpCode, CommonPropType, PropOpCode, ChildOpCode } from "./format.js";

/**
 * ASCII Char Codes.
 */
const enum CharCode {
  /** \\t */Tab = 9,
  /** \\n */Newline = 10,
  /** \\r */CarriageReturn = 13,
  /**     */Space = 32,
  /**  \" */DoubleQuote = 34,
  /**  \# */Hash = 35,
  /**   & */Ampersand = 38,
  /**   ' */Quote = 39,
  /**  \* */Asterisk = 42,
  /**  \+ */PlusSign = 43,
  /**  \- */MinusSign = 45,
  /**   . */Dot = 46,
  /**   : */Colon = 58,
  /**   < */LessThan = 60,
  /**   = */EqualsTo = 61,
  /**   @ */AtSign = 64,
  /**   ~ */Tilde = 126,
}

/**
 * Template Compiler.
 */
interface TemplateCompiler {
  /** Static strings. */
  statics: string[] | TemplateStringsArray;
  /** Current static string. */
  text: string;
  /** Text index. */
  i: number;
  /** Expr index. */
  e: number;

  /** Curent node indentation level. */
  indent: number;
  /** Try hoist expression. */
  tryHoistExpr: (i: number) => boolean,

  // output:
  /** Root element tag name */
  rootTagName: string,
  /** Basic template (element without static attributes or children) */
  isBasic: boolean,
  /** The number of children slots. */
  childrenSize: number,
  /** Static template strings and expressions. */
  template: (string | number)[];
  /** Static data. */
  data: string[],
  /** State opCodes */
  stateOpCodes: StateOpCode[],
  /** Dynamic expressions */
  dynamicExprs: number[],
}

const COMPILER: TemplateCompiler = {
  statics: null!,
  text: "",
  i: 0,
  e: 0,
  indent: 0,
  tryHoistExpr: null!,
  rootTagName: "",
  isBasic: true,
  childrenSize: 0,
  template: [],
  data: [],
  stateOpCodes: [],
  dynamicExprs: [],
};

const IDENTIFIER = /[a-zA-Z_][\w-]*/y;
const JS_PROPERTY = /[a-zA-Z_$][\w]*/y;

export class TemplateCompilerError extends Error {
  staticsOffset: number;
  textOffset: number;

  constructor(message: string, staticsOffset: number, textOffset: number) {
    super(message);
    this.staticsOffset = staticsOffset;
    this.textOffset = textOffset;
  }
}

const error = (msg: string): never => {
  throw new TemplateCompilerError(msg, COMPILER.e, COMPILER.i);
};

const expr = (): number => {
  var e;
  var c = COMPILER;
  return (c.i === c.text.length && (e = c.e) < (c.statics.length - 1))
    ? (c.i = 0, c.text = c.statics[++c.e], e)
    : -1;
};

/**
 * `RegExp` should have sticky "y" flag.
 */
const regexp = (re: RegExp): string | undefined => {
  var match;
  var c = COMPILER;
  re.lastIndex = c.i;
  return ((match = re.exec(c.text)) !== null)
    ? (match = match[0], c.i += match.length, match)
    : void 0;
};

/**
 * Skips whitespace and returns indentation level.
 *
 * @returns Indentation level.
 */
const whitespace = (): boolean => {
  var c;
  var comp = COMPILER;
  var text = comp.text;
  var i = comp.i;
  var indent = comp.indent;
  while (i < text.length) {
    c = text.charCodeAt(i++);
    if (c === CharCode.Space || c === CharCode.Tab) {
      indent++;
      continue;
    }
    if (c === CharCode.Newline || c === CharCode.CarriageReturn) {
      indent = 0;
      continue;
    }
    i--;
    break;
  }

  return (i !== comp.i)
    ? (comp.indent = indent, comp.i = i, true)
    : false;
};

/**
 * Two types of strings:
 *
 * 'basic string'
 * ##'stri'n'g'##
 */
const string = (isAttribute: boolean): string => {
  var c;
  var start;
  var end;
  var j;
  var hashDelim = 0;
  var s = "";
  var comp = COMPILER;
  var text = comp.text;
  var length = text.length;
  var i = comp.i;
  if (i < length) {
    while ((c = text.charCodeAt(i++)) === CharCode.Hash && i < length) {
      hashDelim++;
    }

    if (c === CharCode.Quote) {
      start = i;
      outer: while (i < length) {
        if ((c = text.charCodeAt(i++)) === CharCode.Quote) {
          end = i - 1;
          if ((j = i + hashDelim) > length) {
            error("invalid string");
          }
          while (i < j) {
            if (text.charCodeAt(i) !== CharCode.Hash) {
              continue outer;
            }
            i++;
          }
          comp.i = i;
          return s + text.substring(start, end);
        }

        if (c === CharCode.Ampersand) {
          c = "&amp;"; // &
        } else if (isAttribute === true) {
          if (c !== CharCode.DoubleQuote) {
            continue;
          }
          c = "&quot;";
        } else if (c === CharCode.LessThan) { // StringContext.Text
          c = "&lt;";
        } else {
          continue;
        }

        s += text.substring(start, i - 1) + c;
        start = i;
      }
    }
  }
  return "";
};

const eq = (): boolean => {
  var comp = COMPILER;
  var text = comp.text;
  return (comp.i < text.length && text.charCodeAt(comp.i) === CharCode.EqualsTo)
    ? (comp.i++, true)
    : false;
};

const attributeProp = (opCodes: PropOpCode[], key: string) => {
  var value;
  var comp = COMPILER;
  if (eq()) { // =
    if ((value = string(true)) !== "") {
      comp.isBasic = false;
      comp.template.push(' ' + key + '="' + value + '"');
    } else {
      if ((value = expr()) === -1) {
        error("expected a string or an expression");
      }
      if (comp.tryHoistExpr(value) === true) {
        comp.isBasic = false;
        comp.template.push(' ' + key + '="', value, '"');
      } else {
        opCodes.push(
          PropOpCode.Attribute
          | (dynamicExpr(value) << PropOpCode.InputShift)
          | (comp.data.length << PropOpCode.DataShift)
        );
        comp.data.push(key);
      }
    }
  } else {
    comp.isBasic = false;
    comp.template.push(' ' + key);
  }
};

const dynamicProp = (opCodes: PropOpCode[], opCode: PropOpCode, key: string) => {
  if (!eq()) {
    error("expected a '=' character");
  }
  var data = COMPILER.data;
  var v = expr();
  if (v === -1) {
    error("expected an expression");
  }
  opCodes.push(
    opCode
    | (dynamicExpr(v) << PropOpCode.InputShift)
    | (data.length << PropOpCode.DataShift)
  );
  data.push(key);
};

interface ParsedElement {
  /** `stateOpCodesStart` */
  stateIndex: number;
  /** Property opCodes */
  propOpCodes: PropOpCode[];
  /** Direct children opCodes */
  childOpCodes: ChildOpCode[];
  /** Subtree */
  children: ParsedElement[];
}

const VOID_ELEMENTS = /^(audio|video|embed|input|param|source|textarea|track|area|base|link|meta|br|col|hr|img|wbr)$/;

const enum ParseElementState {
  Initial = 0,
  PrevText = 1,
  PrevExpr = 1 << 1,

  /** Indentation level for inline nodes. */
  InlineIndentLevel = 1 << 16
}

/**
 * Adds a dynamic expr and returns its index.
 */
const dynamicExpr = (i: number) => COMPILER.dynamicExprs.push(i) - 1;

/**
 * `stateIndex` points to `Enter` opCode for the current element. `-1` value
 * indicates that it is a root node.
 */
const element = (stateIndex: number): ParsedElement | null => {
  var tmp;
  var v;
  var className;
  var propOpCodes: PropOpCode[] = [];
  var childOpCodes: ChildOpCode[] = [];
  var children: ParsedElement[] = [];
  var state = ParseElementState.Initial;
  var comp = COMPILER;
  var eSize = comp.statics.length - 1;
  var indent = comp.indent;
  var stateOpCodes: StateOpCode[] = comp.stateOpCodes;
  var template = comp.template;
  var tagName = regexp(IDENTIFIER);
  if (tagName === void 0) {
    error("expected a valid tag name");
  }
  if (stateIndex === -1) {
    comp.rootTagName = tagName!;
  }
  if (indent < ParseElementState.InlineIndentLevel) {
    comp.indent = ParseElementState.InlineIndentLevel;
  }
  template.push("<" + tagName);
  // Dynamic class name
  if ((v = expr()) !== -1) {
    if (comp.tryHoistExpr(v) === true) {
      comp.isBasic = false;
      template.push(' class="', v, '"');
    } else {
      propOpCodes.push(
        PropOpCode.Common
        | (CommonPropType.ClassName << PropOpCode.DataShift)
        | (dynamicExpr(v) << PropOpCode.InputShift)
      );
    }
  } else {
    // parse class names, e.g. `div.classA.classB`
    while (comp.i < comp.text.length) {
      v = comp.text.charCodeAt(comp.i);
      if (v === CharCode.Dot) {
        comp.i++;
        if ((tmp = regexp(IDENTIFIER)) === void 0) {
          error("expected a valid class name");
        }
        className = (className === void 0)
          ? tmp
          : className + " " + tmp;
      } else {
        break;
      }
    }
    if (className !== void 0) {
      comp.isBasic = false;
      template.push(' class="' + className + '"');
    }
  }

  whitespace();
  while (comp.indent > indent && comp.i < comp.text.length) {
    v = comp.text.charCodeAt(comp.i);
    if (v === CharCode.Colon) { // :attribute
      comp.i++;
      if ((tmp = regexp(IDENTIFIER)) === void 0) {
        error("expected a valid attribute name");
      }
      attributeProp(propOpCodes, tmp!);
    } else if (v === CharCode.Dot) { // .property
      comp.i++;
      if ((tmp = regexp(JS_PROPERTY)) === void 0) {
        error("expected a valid property name");
      }
      dynamicProp(propOpCodes, PropOpCode.Property, tmp!);
    } else if (v === CharCode.Asterisk) { // *value
      comp.i++;
      if ((tmp = regexp(JS_PROPERTY)) === void 0) {
        error("expected a valid property name");
      }
      dynamicProp(propOpCodes, PropOpCode.DiffDOMProperty, tmp!);
    } else if (v === CharCode.Tilde) { // ~style
      comp.i++;
      if ((tmp = regexp(IDENTIFIER)) === void 0) {
        error("expected a valid property name");
      }
      dynamicProp(propOpCodes, PropOpCode.Style, tmp!);
    } else if (v === CharCode.AtSign) { // @event
      comp.i++;
      if ((tmp = regexp(IDENTIFIER)) === void 0) {
        error("expected a valid event name");
      }
      dynamicProp(propOpCodes, PropOpCode.Event, tmp!);
    } else if (v === 36) { // $${directive}
      comp.i++;
      if ((v = expr()) === -1) {
        error("expected an attribute directive expression");
      }
      propOpCodes.push(PropOpCode.Directive | (dynamicExpr(v) << PropOpCode.InputShift));
    } else {
      break;
    }

    whitespace();
  }
  template.push(">");

  if (!VOID_ELEMENTS.test(tagName!)) {
    while (comp.indent > indent) {
      if (comp.i < comp.text.length) {
        comp.isBasic = false;

        if (state & ParseElementState.PrevExpr) {
          childOpCodes.push(ChildOpCode.SetNext | (stateOpCodes.length << ChildOpCode.ValueShift));
          stateOpCodes.push(StateOpCode.Next | StateOpCode.Save | StateOpCode.AssignSlot);
        } else {
          stateOpCodes.push(StateOpCode.Next);
        }

        if ((v = string(false)) !== "") {
          // Inject marker nodes when expression is between two texts.
          if (
            (state & (ParseElementState.PrevExpr | ParseElementState.PrevText)) ===
            (ParseElementState.PrevExpr | ParseElementState.PrevText)
          ) {
            template.push("<!>");
            stateOpCodes.pop();
            stateOpCodes.push(
              StateOpCode.EnterOrRemove | StateOpCode.AssignSlot,
              StateOpCode.Next,
            );
          }
          state = ParseElementState.PrevText;
          template.push(v);
        } else {
          state = 0;
          tmp = stateOpCodes.length;
          if ((v = element(tmp - 1)) !== null) {
            children.push(v);
          }
          if (stateOpCodes.length !== tmp) {
            stateOpCodes[tmp - 1] = (
              StateOpCode.EnterOrRemove
              | ((stateOpCodes.length - tmp) << StateOpCode.OffsetShift)
              | (stateOpCodes[tmp - 1] & (StateOpCode.Save | StateOpCode.AssignSlot))
            );
            stateOpCodes.push(StateOpCode.Next);
          }
        }
      } else if (comp.e < eSize) {
        state |= ParseElementState.PrevExpr;
        childOpCodes.push(dynamicExpr(expr()) << ChildOpCode.ValueShift);
        comp.childrenSize++;
      } else {
        break;
      }

      whitespace();
    }

    template.push("</" + tagName + ">");

    // remove trailing NEXT or ENTER opCodes.
    v = stateOpCodes.length;
    while (--v > stateIndex) {
      tmp = stateOpCodes[v];
      if (tmp & StateOpCode.AssignSlot) {
        // Workaround to preserve Remove opCodes
        if (tmp & (StateOpCode.Next | (StateOpCode.Mask10 << StateOpCode.OffsetShift))) {
          stateOpCodes[v] = StateOpCode.Save | StateOpCode.AssignSlot;
        }
        break;
      } else {
        stateOpCodes.pop();
      }
    }
  }

  if (stateIndex !== -1 && (propOpCodes.length > 0 || childOpCodes.length > 0)) {
    stateOpCodes[stateIndex] |= StateOpCode.Save | StateOpCode.AssignSlot;
  } else if (propOpCodes.length === 0 && childOpCodes.length === 0 && children.length === 0) {
    return null;
  }

  return { stateIndex, propOpCodes, childOpCodes, children };
};

const emitOpCodes = (
  propOpCodes: number[],
  childOpCodes: number[],
  stateOpCodes: number[],
  element: ParsedElement,
) => {
  var op;
  var i;
  var elementSlot;
  var arr: PropOpCode[] | ChildOpCode[] | ParsedElement[] = element.propOpCodes;
  if ((elementSlot = element.stateIndex) !== -1) {
    elementSlot = stateOpCodes[elementSlot] >> StateOpCode.SaveSlotShift;
  }

  if (arr.length > 0) {
    if (elementSlot !== -1) {
      propOpCodes.push(PropOpCode.SetNode | (elementSlot << PropOpCode.DataShift));
    }
    propOpCodes.push(...arr);
  }

  arr = element.childOpCodes;
  i = arr.length;
  if (i > 0) {
    if (elementSlot !== -1) {
      childOpCodes.push(ChildOpCode.SetParent | (elementSlot << ChildOpCode.ValueShift));
    }
    do {
      op = arr[--i];
      if (op & ChildOpCode.SetNext) {
        childOpCodes.push(
          ChildOpCode.SetNext
          | ((stateOpCodes[op >> ChildOpCode.ValueShift] >> StateOpCode.SaveSlotShift) << ChildOpCode.ValueShift)
        );
      } else {
        childOpCodes.push(op);
      }
    } while (i > 0);
  }

  arr = element.children;
  i = arr.length;
  while (--i >= 0) {
    emitOpCodes(propOpCodes, childOpCodes, stateOpCodes, arr[i]);
  }
};

export interface TemplateCompilationArtifact {
  /** Template Cloning disabled */
  disableCloning: boolean,
  /** Template Flags */
  flags: TemplateFlags;
  /** Static Template */
  template: (string | number)[] | string,
  /** Prop OpCodes */
  propOpCodes: PropOpCode[],
  /** Child OpCodes */
  childOpCodes: ChildOpCode[],
  /** State OpCodes */
  stateOpCodes: StateOpCode[],
  /** Data */
  data: string[],
  /** Dynamic Expressions */
  dynamicExprs: number[],
}

export const compileTemplate = (
  s: string[] | TemplateStringsArray,
  svg: boolean,
  tryHoistExpr: (i: number) => boolean,
): TemplateCompilationArtifact => {
  if (s.length === 0) {
    error("empty template");
  }
  var op;
  var node;
  var i;
  var disableCloning = false;
  var stateSize = 1;
  var propOpCodes: PropOpCode[] = [];
  var childOpCodes: ChildOpCode[] = [];
  var comp = COMPILER;
  var stateOpCodes = comp.stateOpCodes;
  var text = s[0];
  comp.text = text;
  comp.statics = s;
  comp.tryHoistExpr = tryHoistExpr;

  try {
    // Parse flags:
    //   -c Disable template cloning.
    if (text.length > 1) {
      if (text.charCodeAt(0) === CharCode.MinusSign) {
        if (text.charCodeAt(1) === 99) { // "c"
          disableCloning = true;
          comp.i = 2;
          if (!whitespace()) {
            error("expected a whitespace");
          }
        } else {
          error("expected an option flag");
        }
      } else {
        whitespace();
      }
    }

    if ((node = element(-1)) !== null) {
      // Assign slots in state opCodes.
      for (i = 0; i < stateOpCodes.length; i++) {
        op = stateOpCodes[i];
        if (op & StateOpCode.AssignSlot) {
          stateOpCodes[i] = (
            (op & ((1 << StateOpCode.SaveSlotShift) - 1))
            | (stateSize++ << StateOpCode.SaveSlotShift)
          );
        }
      }
      emitOpCodes(propOpCodes, childOpCodes, stateOpCodes, node);
      // Clean slots in state opCodes.
      for (i = 0; i < stateOpCodes.length; i++) {
        stateOpCodes[i] &= (1 << StateOpCode.SaveSlotShift) - 1;
      }
    }

    return {
      disableCloning,
      flags: ((svg === true) ? TemplateFlags.Svg : 0) | stateSize | (comp.childrenSize << 10),
      template: (comp.isBasic) ? comp.rootTagName : comp.template,
      propOpCodes,
      childOpCodes,
      stateOpCodes,
      data: comp.data,
      dynamicExprs: comp.dynamicExprs,
    };
  } finally {
    comp.statics = null!;
    comp.text = "";
    comp.e = 0;
    comp.i = 0;
    comp.indent = 0;
    comp.isBasic = true;
    comp.childrenSize = 0;
    comp.template = [];
    comp.data = [];
    comp.stateOpCodes = [];
    comp.dynamicExprs = [];
  }
};
