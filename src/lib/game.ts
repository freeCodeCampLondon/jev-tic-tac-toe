/** Board model + tic-tac-toe rules. */
import { formatErrors, parseJsonSafe, validateBoardState, type ValidationIssue } from "./schemas";

export type Cell = "X" | "O" | ".";
export type Board = [Cell[], Cell[], Cell[]];

export const EMPTY_BOARD: Board = [
  [".", ".", "."],
  [".", ".", "."],
  [".", ".", "."],
];

/** Map a criterion id like "c2-r1" -> { row, col } (0-based). */
export function criterionToCell(id: string): { row: number; col: number } | null {
  const m = /^c([1-3])-r([1-3])$/.exec(id);
  if (!m) return null;
  return { col: Number(m[1]) - 1, row: Number(m[2]) - 1 };
}

export function cellToCriterion(row: number, col: number): string {
  return `c${col + 1}-r${row + 1}`;
}

/** Whose turn it is based on piece counts. X always starts. */
export function currentTurn(board: Board): "X" | "O" {
  let x = 0, o = 0;
  for (const row of board) for (const c of row) {
    if (c === "X") x++;
    else if (c === "O") o++;
  }
  return x === o ? "X" : "O";
}

export function countPieces(board: Board): { X: number; O: number } {
  let x = 0, o = 0;
  for (const row of board) for (const c of row) {
    if (c === "X") x++;
    else if (c === "O") o++;
  }
  return { X: x, O: o };
}

export interface WinResult {
  winner: Cell;
  line: [number, number][]; // cells of the winning line
}

export function findWinner(board: Board): WinResult | null {
  const lines: [number, number][][] = [
    [[0, 0], [0, 1], [0, 2]],
    [[1, 0], [1, 1], [1, 2]],
    [[2, 0], [2, 1], [2, 2]],
    [[0, 0], [1, 0], [2, 0]],
    [[0, 1], [1, 1], [2, 1]],
    [[0, 2], [1, 2], [2, 2]],
    [[0, 0], [1, 1], [2, 2]],
    [[0, 2], [1, 1], [2, 0]],
  ];
  for (const line of lines) {
    const [a, b, c] = line;
    const v = board[a[0]][a[1]];
    if (v !== "." && board[b[0]][b[1]] === v && board[c[0]][c[1]] === v) {
      return { winner: v, line };
    }
  }
  return null;
}

export function isFull(board: Board): boolean {
  for (const row of board) for (const c of row) if (c === ".") return false;
  return true;
}

/** Apply a move; returns a new board or null if the cell is taken. */
export function applyMove(board: Board, row: number, col: number, piece: Cell): Board | null {
  if (board[row][col] !== ".") return null;
  const next = board.map((r) => [...r]) as Board;
  next[row][col] = piece;
  return next;
}

/**
 * Apply a Jev answer's chosen criterion (e.g. "c2-r3") to the board as
 * `piece`. Returns the new board, or an error message if the choice is
 * unknown or the cell is already occupied. Pure — callers decide what to do
 * with the result (show it locally, send it, both…).
 */
export function applyJevChoice(board: Board, piece: Cell, choice: string): { board?: Board; error?: string } {
  const cell = criterionToCell(choice);
  if (!cell) return { error: `Unknown criterion "${choice}"` };
  const next = applyMove(board, cell.row, cell.col, piece);
  if (!next) return { error: "Jev's chosen cell is already occupied — update the board and try again." };
  return { board: next };
}

export function cloneBoard(board: Board): Board {
  return board.map((r) => [...r]) as Board;
}

/**
 * Pretty-print board state with each row on a single line — easier to read and
 * edit by hand:
 *   { "board": [ ["X","O","."], [".","X","X"], [".",".","O"] ] }
 * Throws on invalid JSON (caller decides how to surface it). Falls back to
 * standard 2-space pretty-printing if the shape isn't a plain board object.
 */
export function formatBoardStateText(raw: string): string {
  const parsed = JSON.parse(raw) as { board?: unknown } & Record<string, unknown>;
  const board = parsed?.board;
  const isBoardShape =
    Array.isArray(board) &&
    board.length > 0 &&
    board.every((row) => Array.isArray(row) && row.length > 0 && row.every((cell) => typeof cell === "string")) &&
    Object.keys(parsed).filter((k) => k !== "board").length === 0;
  if (!isBoardShape) return JSON.stringify(parsed, null, 2);

  const rows = (board as string[][]).map((row) => "    [" + row.map((c) => JSON.stringify(c)).join(", ") + "]");
  return '{\n  "board": [\n' + rows.join(",\n") + "\n  ]\n}";
}

/** Serialize a board back into the State editor's one-row-per-line JSON. */
export function boardToJson(board: Board): string {
  return formatBoardStateText(JSON.stringify({ board }));
}

/** Parse the state editor into a board, if it is valid. */
export function parseBoard(text: string): { board: Board | null; issues: ValidationIssue[] } {
  const parsed = parseJsonSafe(text);
  if (!parsed.ok) return { board: null, issues: [{ path: "state", message: `Invalid JSON: ${parsed.error}` }] };
  const valid = validateBoardState(parsed.value);
  if (!valid) return { board: null, issues: formatErrors(validateBoardState.errors).map((i) => ({ path: `state${i.path}`, message: i.message })) };
  return { board: (parsed.value as { board: Board }).board, issues: [] };
}

/** Structural equality for two boards. */
export function boardsEqual(a: Board, b: Board): boolean {
  return a.every((row, r) => row.every((c, ci) => c === b[r][ci]));
}
