import { z } from "zod";
import type { ToolRegistry } from "./registry";

const ASK_TIMEOUT_S = () => Math.round(Number(process.env.NORMA_ASK_TIMEOUT_MS ?? 300_000) / 1000);
const NO_ANSWER = () => `No answer within ${ASK_TIMEOUT_S()}s — the user is not available right now. Proceed with your best judgment and note the assumption.`;

const AskUserArgs = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    header: z.string().min(1).max(12),
    options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).min(2).max(4),
    multiSelect: z.boolean(),
  })).min(1).max(4),
});

export function registerAskUserTool(r: ToolRegistry): void {
  r.register({
    name: "ask_user",
    description:
      "Ask the user 1-4 questions when you are blocked on a decision only they can make — one you cannot resolve from the request, the code, or sensible defaults. " +
      "Each question has 2-4 distinct option choices; do NOT add an 'Other' option (the interface adds a free-text 'Other' automatically). " +
      "If you recommend an option, put it first and append ' (Recommended)' to its label. Use multiSelect: true when choices are not mutually exclusive. " +
      "The user's answers are returned; if no one answers in time you'll be told to proceed with your best judgment.",
    args: AskUserArgs,
    async run({ questions }: z.infer<typeof AskUserArgs>, ctx) {
      if (!ctx.ask) return NO_ANSWER();
      const res = await ctx.ask(questions);
      if ("timedOut" in res) return NO_ANSWER();
      const lines = questions.map((q) => `- ${q.header}: ${res.answers[q.question] ?? "(no answer)"}`);
      return `User answered:\n${lines.join("\n")}`;
    },
  });
}
