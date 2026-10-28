/** One subtask in a plan an agent proposed. `id` is local to the plan; `dependsOn` lists other subtask ids. */
export type Subtask = { id: string; title: string; body: string; dependsOn: string[] };

/**
 * Reads the last fenced `bakery-plan` block in an agent report: a JSON array of
 * `{ id, title, body, dependsOn? }`. Returns the subtasks in an order where every one follows its dependencies,
 * or an error naming what is wrong (bad JSON, duplicate or unknown ids, a cycle, more than 20 subtasks).
 * A report without the block has no plan.
 */
export function parsePlan(report: string): { subtasks: Subtask[] } | { error: string } | null {
  const blocks = [...report.matchAll(/^```bakery-plan[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)];
  if (!blocks.length) return null;
  let data: unknown;
  try { data = JSON.parse(blocks[blocks.length - 1][1]); } catch { return { error: "The plan is not valid JSON." }; }
  if (!Array.isArray(data) || !data.length) return { error: "The plan must be a non-empty list." };
  if (data.length > 20) return { error: "The plan has more than 20 subtasks." };
  const subtasks: Subtask[] = [];
  for (const raw of data) {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim() ||
      typeof item.title !== "string" || !item.title.trim() || typeof item.body !== "string" || !item.body.trim() ||
      (item.dependsOn !== undefined && (!Array.isArray(item.dependsOn) || !item.dependsOn.every(dep => typeof dep === "string"))))
      return { error: "Each subtask needs an id, a title, a body and an optional dependsOn list of ids." };
    if (subtasks.some(other => other.id === item.id)) return { error: `Subtask id "${item.id}" is used twice.` };
    subtasks.push({ id: item.id, title: item.title.trim().slice(0, 200), body: item.body.trim(), dependsOn: [...new Set(item.dependsOn as string[] | undefined ?? [])] });
  }
  const ids = new Set(subtasks.map(task => task.id));
  for (const task of subtasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) return { error: `Subtask "${task.id}" depends on unknown id "${dep}".` };
    if (dep === task.id) return { error: `Subtask "${task.id}" depends on itself.` };
  }
  const ordered: Subtask[] = [], done = new Set<string>();
  while (ordered.length < subtasks.length) {
    const next = subtasks.filter(task => !done.has(task.id) && task.dependsOn.every(dep => done.has(dep)));
    if (!next.length) return { error: "The plan's dependencies form a cycle." };
    for (const task of next) { ordered.push(task); done.add(task.id); }
  }
  return { subtasks: ordered };
}
