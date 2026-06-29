import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, ChevronDown, Check, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MODELS, type AgentModel } from "@/lib/models";

interface PromptBarProps {
  onStart: (text: string, model: AgentModel) => void;
  running: boolean;
  model: AgentModel;
  onModelChange: (m: AgentModel) => void;
}

export function PromptBar({ onStart, running, model, onModelChange }: PromptBarProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !running && text.trim().length > 0;

  // Auto-grow the textarea up to 240px, then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = el.scrollHeight;
    if (next > 240) {
      el.style.height = "240px";
      el.style.overflowY = "auto";
    } else {
      el.style.height = `${next}px`;
      el.style.overflowY = "hidden";
    }
  }, [text]);

  function send() {
    if (!canSend) return;
    onStart(text.trim(), model);
    setText("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="rounded-xl border bg-card shadow-sm p-3 flex flex-col gap-2">
        {/* Composer textarea — card is the visual frame; textarea strips its own border/bg */}
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the agent…"
          aria-label="Message the agent"
          disabled={running}
          rows={1}
          className="min-h-0 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />

        {/* Bottom action row */}
        <div className="flex items-center justify-between">
          {/* LEFT: model / agent selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                aria-label={`Model: ${model.label}`}
              >
                <Bot data-icon="inline-start" />
                <span className="text-sm">{model.label}</span>
                {model.tier && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">
                    {model.tier}
                  </Badge>
                )}
                <ChevronDown data-icon="inline-end" className="opacity-50" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start" className="min-w-56">
              <DropdownMenuGroup>
                {MODELS.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    disabled={!m.available}
                    onSelect={() => onModelChange(m)}
                    className="gap-2"
                  >
                    <Check
                      className={cn("shrink-0", m.id === model.id ? "opacity-100" : "opacity-0")}
                    />
                    <span className="flex-1">{m.label}</span>
                    {m.tier && (
                      <Badge variant="secondary" className="text-xs px-1.5 py-0">
                        {m.tier}
                      </Badge>
                    )}
                    {!m.available && (
                      <span className="text-xs text-muted-foreground">Coming soon</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* RIGHT: attach + send */}
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Attach" className="size-8">
              <Paperclip data-icon />
            </Button>
            <Button
              size="icon"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
              className="size-8 rounded-full"
            >
              <ArrowUp data-icon />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
