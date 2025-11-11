"use client";

import { useRef, useState } from "react";

export default function Page() {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question) return;
    setInput("");

    // Append user message
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    // Append placeholder assistant message
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    const currentIndex = messages.length + 1; // assistant index
    const controller = new AbortController();
    controllerRef.current = controller;

    const res = await fetch("/api/iphone17", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });

    if (!res.body) {
      setMessages((prev) => {
        const next = prev.slice();
        next[currentIndex] = {
          role: "assistant",
          content: "Sorry, something went wrong.",
        };
        return next;
      });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Stream and append chunks
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      setMessages((prev) => {
        const next = prev.slice();
        const current = next[currentIndex]!;
        next[currentIndex] = { ...current, content: current.content + chunk };
        return next;
      });
    }
  }

  function stop() {
    controllerRef.current?.abort();
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-screen-md flex-col px-4 py-6">
      <h1 className="mb-4 text-center text-2xl font-semibold">iPhone 17 Chat</h1>

      <div className="flex-1 space-y-4 overflow-y-auto rounded-md border p-4">
        {messages.map((m, idx) => (
          <div key={idx} className={m.role === "user" ? "text-right" : "text-left"}>
            <div className="inline-block rounded-lg bg-secondary px-3 py-2">
              <span className="whitespace-pre-wrap">{m.content}</span>
            </div>
          </div>
        ))}
        {!messages.length && (
          <p className="text-center text-muted-foreground">
            Ask anything about the iPhone 17.
          </p>
        )}
      </div>

      <form onSubmit={sendMessage} className="mt-4 flex gap-2">
        <input
          className="flex-1 rounded-md border px-3 py-2"
          placeholder="Type your question..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-primary-foreground">
          Send
        </button>
        <button
          type="button"
          onClick={stop}
          className="rounded-md border px-4 py-2"
          title="Stop streaming"
        >
          Stop
        </button>
      </form>
    </div>
  );
}



