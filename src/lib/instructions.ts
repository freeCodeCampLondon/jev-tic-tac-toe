import instructionRaw from "../../instruction.json?raw";

/**
 * The instructions sentence for a given piece. Which side you play is stated
 * unambiguously ("playing as X/O"), and the turn order fact — X moves first in
 * a new game — is always included so the model knows who starts no matter
 * which side it plays. (A rematch also resets to X-first, so this stays true.)
 */
export function instructionForRole(role: "X" | "O"): string {
  const order =
    role === "X"
      ? "X moves first in a new game, so you move first."
      : "X moves first in a new game, so you (O) move second.";
  return (
    "This is a tic-tac-toe game. The state shows the current board; '.' means an empty cell. " +
    `You are playing as ${role}. ${order} ` +
    "You can only place your piece on an empty cell. " +
    "What is your next move in order to win? To avoid losing, it's a good idea to block your opponent from winning."
  );
}

/** Full Questions JSON (type + criteria come from instruction.json) with the
 *  instructions tailored to the piece you play. */
export function buildInstructionJson(role: "X" | "O"): string {
  const parsed = JSON.parse(instructionRaw) as {
    game: { type: string; instructions: string; criteria: Record<string, string> };
  };
  parsed.game.instructions = instructionForRole(role);
  return JSON.stringify(parsed, null, 2);
}
