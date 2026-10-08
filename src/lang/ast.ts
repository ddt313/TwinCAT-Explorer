// Syntax tree of TwinCAT Structured Text. Offsets are relative to the section text.

export interface Span {
  start: number;
  end: number;
}

export interface Ident extends Span {
  kind: 'Ident';
  name: string;
  upper: string;
}

export interface QualName extends Span {
  parts: Ident[];
}

export interface Arg extends Span {
  name?: Ident;
  op?: ':=' | '=>';
  negated?: boolean;
  value?: Expr;
}

export type TypeSpec =
  | (Span & { kind: 'NamedType'; name: QualName; args?: Arg[]; range?: { lo: Expr; hi: Expr } })
  | (Span & { kind: 'StringType'; wide: boolean; length?: Expr })
  | (Span & { kind: 'ArrayType'; dims: ({ lo: Expr; hi: Expr } | '*')[]; of: TypeSpec })
  | (Span & { kind: 'PointerType'; to: TypeSpec })
  | (Span & { kind: 'ReferenceType'; to: TypeSpec })
  | (Span & { kind: 'EnumType'; values: EnumValueDecl[]; base?: TypeSpec })
  | (Span & { kind: 'StructType'; union: boolean; fields: VarDecl[] });

export interface EnumValueDecl extends Span {
  name: Ident;
  init?: Expr;
}

export interface VarDecl extends Span {
  names: Ident[];
  type?: TypeSpec;
  init?: Expr;
  at?: string;
}

export interface VarBlock extends Span {
  section: string;
  qualifiers: string[];
  decls: VarDecl[];
}

export interface Header extends Span {
  /** FUNCTION_BLOCK, PROGRAM, FUNCTION, METHOD, PROPERTY, INTERFACE, ACTION */
  pouKind: string;
  modifiers: string[];
  name?: Ident;
  returnType?: TypeSpec;
  extends: QualName[];
  implements: QualName[];
}

export interface TypeDecl extends Span {
  name: Ident;
  extends?: QualName;
  spec: TypeSpec;
  init?: Expr;
}

export interface DeclUnit extends Span {
  header?: Header;
  varBlocks: VarBlock[];
  typeDecls: TypeDecl[];
  /** Methods and properties declared inside a stub FUNCTION_BLOCK/INTERFACE. */
  members: DeclUnit[];
}

export type Expr =
  | Ident
  | (Span & { kind: 'Member'; object: Expr; member: Ident })
  | (Span & { kind: 'BitAccess'; object: Expr; bit: string })
  | (Span & { kind: 'Index'; object: Expr; indices: Expr[] })
  | (Span & { kind: 'Deref'; object: Expr })
  | (Span & { kind: 'Call'; callee: Expr; args: Arg[] })
  | (Span & { kind: 'Unary'; op: string; operand: Expr })
  | (Span & { kind: 'Binary'; op: string; left: Expr; right: Expr })
  | (Span & { kind: 'Literal'; litType: LiteralType; text: string })
  | (Span & { kind: 'TypedLiteral'; prefix: Ident; value: string; valueIdent?: Ident })
  | (Span & { kind: 'Paren'; expr: Expr })
  | (Span & { kind: 'ArrayInit'; items: Expr[] })
  | (Span & { kind: 'StructInit'; fields: { name: Ident; value: Expr }[] })
  | (Span & { kind: 'Range'; lo: Expr; hi: Expr })
  | (Span & { kind: 'Error' });

export type LiteralType = 'int' | 'real' | 'bool' | 'string' | 'wstring' | 'time' | 'ltime' | 'date' | 'tod' | 'dt';

export type Stmt =
  | (Span & { kind: 'Assign'; target: Expr; op: string; value: Expr })
  | (Span & { kind: 'ExprStmt'; expr: Expr })
  | (Span & { kind: 'If'; branches: { cond: Expr; body: Stmt[] }[]; elseBody?: Stmt[] })
  | (Span & { kind: 'Case'; expr: Expr; cases: { labels: Expr[]; body: Stmt[] }[]; elseBody?: Stmt[] })
  | (Span & { kind: 'For'; variable: Ident; from: Expr; to: Expr; by?: Expr; body: Stmt[] })
  | (Span & { kind: 'While'; cond: Expr; body: Stmt[] })
  | (Span & { kind: 'Repeat'; body: Stmt[]; cond: Expr })
  | (Span & { kind: 'Jump'; keyword: string })
  | (Span & { kind: 'Jmp'; label: Ident })
  | (Span & { kind: 'Label'; label: Ident })
  | (Span & { kind: 'Empty' });

export interface ParseError extends Span {
  message: string;
}
