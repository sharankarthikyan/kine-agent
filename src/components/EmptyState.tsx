import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { MessageSquare } from "lucide-react";

interface EmptyStateProps {
  heading: string;
  hint: string;
}

export function EmptyState({ heading, hint }: EmptyStateProps) {
  return (
    <Empty className="border-none">
      <EmptyMedia variant="icon">
        <MessageSquare />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{heading}</EmptyTitle>
        <EmptyDescription>{hint}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
