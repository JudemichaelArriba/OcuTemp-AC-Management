declare const process: { env: Record<string, string | undefined> };

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText } from "ai";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export const config = { runtime: "edge" };

const google = createGoogleGenerativeAI({
  apiKey: process.env['GOOGLE_GENERATIVE_AI_API_KEY'],
});

const model = google("gemini-2.0-flash-lite");

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "30 s"),
  prefix: "ocutemp:ratelimit",
  analytics: false,
});

const SYSTEM_PROMPT = `
You are OcuGuide, an AI assistant embedded inside the OcuTemp Facility Intelligence System dashboard.

Your job is to help users understand and use OcuTemp. Answer only about the OcuTemp system, dashboard workflows, features, architecture, and technical overview.

Language rules:
- Reply in the same language as the user's latest message when possible.
- If the user asks for a specific language, use that language.
- If the language is unclear, use simple English.

Answer style:
- Be polite, direct, and efficient.
- Keep normal answers to 1 to 3 short sentences.
- For how-to questions, use at most 4 short numbered steps.
- Do not use markdown styling, headings, bullet symbols, tables, code blocks, bold text, or asterisks.
- If the question is unrelated to OcuTemp, briefly say you can help with OcuTemp only and redirect to a relevant system topic.
- Do not invent live room data, device values, Firebase records, secrets, credentials, or actions you cannot perform.

OcuTemp knowledge:
- Dashboard shows rooms, telemetry, temperature, humidity, occupancy, AC status, energy use, recent logs, and floor plan status.
- Rooms page lets users search rooms, add rooms, edit rooms, delete rooms, assign devices, and switch between card and map views.
- Room details show device telemetry, room schedules, AI auto-apply, manual override, forced-off control, AC target temperature, and override status.
- Reports show energy summaries, charts, room energy trends, monthly totals, runtime, and PDF download.
- Users page is admin-only and is used for staff approval, restriction, and management.
- Floor plan legend: green means AC On, brown means Lab, blue means Classroom, pink means Office, dark blue means Canteen, light green means Comfort Room, and yellow means Library.
- Floor plan condition dots: emerald means comfortable, yellow means slightly warm, amber means warm, orange means hot, red means very hot or high humidity, and gray means off or no telemetry.
- Login, signup, approval checks, protected routes, and settings support account access and system configuration.
- The system uses Angular, Tailwind CSS, Firebase, IoT sensors, occupancy detection, a Random Forest Regression ML model, and AC hardware control.
- The ML model uses humidity and temperature readings to suggest the optimal temperature and AC power state.
- AC control signals are sent 5 times to improve hardware sync during unstable connections or packet drops.
`.trim();

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const ip = req.headers.get("x-forwarded-for") ?? "anonymous";
  const { success } = await ratelimit.limit(ip);

  if (!success) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Please slow down." }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: { messages?: unknown };

  try {
    body = await req.json();
  } catch {
    return new Response("Invalid request body", { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response("No messages provided", { status: 400 });
  }

  const messages = body.messages.slice(-10);
  console.log("[debug] messages:", JSON.stringify(messages));

  const lastMessage = messages[messages.length - 1];
  if (
    typeof lastMessage?.content === "string" &&
    lastMessage.content.length > 500
  ) {
    return new Response("Message too long", { status: 400 });
  }

  try {
    const result = await streamText({
      model,
      system: SYSTEM_PROMPT,
      messages,
      onError({ error }) {
        console.error("[gemini error]", error); 
      },
    });

    return result.toTextStreamResponse();
  } catch (error: any) {
    if (error?.status === 429) {
      return new Response(
        JSON.stringify({ error: "Assistant temporarily unavailable. Try again in a moment." }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Something went wrong.", { status: 500 });
  }
}
