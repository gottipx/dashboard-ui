"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  getISOWeek,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks,
} from "date-fns";
import {
  Activity,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  Menu,
  Moon,
  Pin,
  PinOff,
  Plus,
  ShieldCheck,
  Siren,
  Sun,
  TerminalSquare,
  Wifi,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type NavItem = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

type KanbanCard = {
  id: string;
  title: string;
  projectCode: string;
  issueType: string;
  priority: string;
  assignee: string;
  lane: LaneId;
};

type KanbanColumn = {
  id: LaneId;
  title: string;
  cards: KanbanCard[];
};

type LaneId = "backlog" | "in-progress" | "review" | "done";
type IssueType = "Bug" | "Story" | "Task" | "Epic" | "Spike" | "Incident" | "Improvement" | "Chore";
type Priority = "Highest" | "High" | "Medium" | "Low" | "Lowest";

type Task = {
  id: string;
  title: string;
  description: string;
  project: string;
  agent: string;
  priority: "High" | "Medium" | "Low";
  status: "Todo" | "In Progress" | "Done";
  resolvedAt: string | null;
  tagIds: string[];
};

type Issue = {
  key: string;
  sequence: number;
  title: string;
  description: string;
  issueType: IssueType;
  priority: Priority;
  owner: string;
  reporter: string;
  storyPoints: number;
  acceptanceCriteria: string;
  lane: LaneId;
  order: number;
  resolvedAt: string | null;
  projectCode: string;
  projectName: string;
  tagIds: string[];
};

type Project = {
  id: string;
  code: string;
  title: string;
  description: string;
  docs: string[];
  instruction: string;
  manager: string;
  tagIds: string[];
};

type Tag = {
  id: string;
  label: string;
  color: string;
};

type AgentProfile = {
  name: string;
  state: "ready" | "running" | "down";
  info: string;
  logs: string[];
};

type CalendarEvent = {
  id: string;
  title: string;
  eventTime: string;
  owner: string;
  state: "healthy" | "running" | "warning" | "down";
  details: string;
};

type PieSegment = {
  label: string;
  value: number;
  color: string;
};

type DashboardToast = {
  id: number;
  type: "success" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

type GatewayAgentEntry = {
  id?: string;
  name?: string;
  workspace?: string;
  default?: boolean;
  state?: "ready" | "running" | "down";
  info?: string;
  logs?: string[];
};

type GatewaySessionEntry = {
  id?: string;
  key?: string;
  state?: string;
};

const AUTH_ENABLED = true;
const ISSUE_TYPES: IssueType[] = ["Bug", "Story", "Task", "Epic", "Spike", "Incident", "Improvement", "Chore"];
const PRIORITIES: Priority[] = ["Highest", "High", "Medium", "Low", "Lowest"];

const navItems: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "kanban", label: "Kanban", icon: FolderKanban },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "projects", label: "Projects", icon: FileText },
  { id: "issues", label: "Issues", icon: Siren },
  { id: "metrics", label: "Statistics", icon: Activity },
  { id: "logs", label: "Agent Logs", icon: TerminalSquare },
  { id: "calendar", label: "Calendar", icon: CalendarClock },
  { id: "gateway", label: "Gateway", icon: Wifi },
];

const initialAgentProfiles: AgentProfile[] = [
  {
    name: "resolver-agent",
    state: "ready",
    info: "Idle and ready for assignment",
    logs: [
      "17:04:12 Session started (id: S-8812)",
      "17:06:10 Heartbeat ok (32ms)",
      "17:12:27 Waiting for new tasks",
    ],
  },
  {
    name: "planner-agent",
    state: "running",
    info: "Planning sprint board updates",
    logs: [
      "17:08:05 Picked issue OC-001",
      "17:09:44 Updated acceptance criteria",
      "17:13:10 Syncing board lane priorities",
    ],
  },
  {
    name: "ops-watchdog",
    state: "running",
    info: "Monitoring and alert routing active",
    logs: [
      "17:03:29 Alert stream connected",
      "17:07:33 Linked latency incident PM-000",
      "17:14:03 Re-checking source health",
    ],
  },
  {
    name: "retriever-agent",
    state: "down",
    info: "Heartbeat failed; unreachable",
    logs: [
      "17:05:02 Source timeout detected",
      "17:07:40 Missed 3 consecutive heartbeats",
      "17:08:22 Agent marked unreachable",
    ],
  },
  {
    name: "qa-agent",
    state: "ready",
    info: "Idle and validating queued items",
    logs: [
      "17:01:11 Test suite baseline complete",
      "17:10:19 No blocking regressions detected",
      "17:15:08 Ready for next validation task",
    ],
  },
];

const weekDayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const laneMeta: { id: LaneId; title: string }[] = [
  { id: "backlog", title: "Backlog" },
  { id: "in-progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

function buildKanbanColumnsFromIssues(issues: Issue[]): KanbanColumn[] {
  return laneMeta.map((lane) => {
    const cards = issues
      .filter((issue) => issue.lane === lane.id)
      .sort((a, b) => a.order - b.order)
      .map((issue) => ({
        id: issue.key,
        title: issue.title,
        projectCode: issue.projectCode,
        issueType: issue.issueType,
        priority: issue.priority,
        assignee: issue.owner,
        lane: issue.lane,
      }));
    return { id: lane.id, title: lane.title, cards };
  });
}

function normalizeLaneOrders(items: Issue[], lane: LaneId): Issue[] {
  const ordered = items.filter((issue) => issue.lane === lane).sort((a, b) => a.order - b.order);
  const updates = new Map<string, number>();
  ordered.forEach((issue, idx) => updates.set(issue.key, idx));
  return items.map((issue) =>
    issue.lane === lane && updates.has(issue.key) ? { ...issue, order: updates.get(issue.key)! } : issue
  );
}

function issueStateLabelFromLane(lane: LaneId): "Open" | "Triaged" | "In Progress" | "Done" {
  if (lane === "review") return "Triaged";
  if (lane === "in-progress") return "In Progress";
  if (lane === "done") return "Done";
  return "Open";
}

function StatusLed({ state, title }: { state: string; title?: string }) {
  const styleMap: Record<string, string> = {
    ready: "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.7)]",
    healthy: "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.7)]",
    running: "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.7)]",
    warning: "bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.7)]",
    down: "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.7)]",
    backlog: "bg-zinc-400 shadow-[0_0_10px_rgba(161,161,170,0.7)]",
    review: "bg-violet-500 shadow-[0_0_10px_rgba(139,92,246,0.7)]",
    todo: "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.7)]",
    inprogress: "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.7)]",
    done: "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.7)]",
  };
  return <span title={title} className={cn("inline-block h-[9px] w-[9px] rounded-full", styleMap[state] ?? styleMap.warning)} />;
}

function statusLedFromTaskStatus(status: Task["status"]) {
  if (status === "Done") return "done";
  if (status === "In Progress") return "inprogress";
  return "todo";
}

function statusMeaningFromTaskStatus(status: Task["status"]) {
  if (status === "Done") return "Green: resolved or done";
  if (status === "In Progress") return "Yellow: in progress";
  return "Red: not started";
}

function statusLedFromIssueLane(lane: LaneId) {
  if (lane === "done") return "done";
  if (lane === "review") return "review";
  if (lane === "in-progress") return "inprogress";
  return "backlog";
}

function statusMeaningFromIssueLane(lane: LaneId) {
  if (lane === "done") return "Green: resolved or done";
  if (lane === "review") return "Purple: in review";
  if (lane === "in-progress") return "Yellow: in progress";
  return "Gray: backlog";
}

function PieChart({ title, subtitle, segments }: { title: string; subtitle: string; segments: PieSegment[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  const gradient = segments
    .reduce(
      (acc, segment) => {
        const start = (acc.cursor / total) * 100;
        const nextCursor = acc.cursor + segment.value;
        const end = (nextCursor / total) * 100;
        acc.parts.push(`${segment.color} ${start}% ${end}%`);
        return { cursor: nextCursor, parts: acc.parts };
      },
      { cursor: 0, parts: [] as string[] }
    )
    .parts.join(", ");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <div className="relative h-28 w-28 rounded-full" style={{ background: `conic-gradient(${gradient})` }}>
            <div className="absolute inset-[22%] grid place-content-center rounded-full bg-card text-xs font-semibold">{total}</div>
          </div>
          <div className="space-y-1 text-xs">
            {segments.map((segment) => (
              <div key={segment.label} className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />
                <span className="min-w-20 text-muted-foreground">{segment.label}</span>
                <span className="font-medium">{segment.value}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TagSelector({
  availableTags,
  selectedTagIds,
  onChange,
  onCreateTag,
}: {
  availableTags: Tag[];
  selectedTagIds: string[];
  onChange: (tagIds: string[]) => void;
  onCreateTag: (label: string, color: string) => Promise<string | null>;
}) {
  const [newTagLabel, setNewTagLabel] = useState("");
  const [newTagColor, setNewTagColor] = useState("#3b82f6");

  const toggleTag = (tagId: string) => {
    if (selectedTagIds.includes(tagId)) {
      onChange(selectedTagIds.filter((id) => id !== tagId));
      return;
    }
    onChange([...selectedTagIds, tagId]);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Tags</p>
      <div className="flex flex-wrap gap-2">
        {availableTags.map((tag) => {
          const selected = selectedTagIds.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              onClick={() => toggleTag(tag.id)}
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-1 text-xs text-white transition",
                selected ? "ring-2 ring-primary/40 opacity-100" : "opacity-75 hover:opacity-100"
              )}
              style={{ borderColor: tag.color, backgroundColor: tag.color }}
            >
              {tag.label}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <Input value={newTagLabel} onChange={(event) => setNewTagLabel(event.target.value)} placeholder="New tag name" />
        <Input
          type="color"
          value={newTagColor}
          onChange={(event) => setNewTagColor(event.target.value)}
          className="h-9 w-12 p-1"
        />
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            const createdId = await onCreateTag(newTagLabel, newTagColor);
            if (createdId) {
              onChange(selectedTagIds.includes(createdId) ? selectedTagIds : [...selectedTagIds, createdId]);
              setNewTagLabel("");
            }
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function getKanbanBorderClass(columnId: string) {
  if (columnId === "in-progress") return "border-l-amber-400";
  if (columnId === "review") return "border-l-violet-500";
  if (columnId === "done") return "border-l-emerald-500";
  return "border-l-zinc-400";
}

function SortableCardItem({
  card,
  borderClass,
  onOpenIssue,
}: {
  card: KanbanCard;
  borderClass: string;
  onOpenIssue?: (issueKey: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });

  return (
    <Card
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("cursor-grab border-l-4 active:cursor-grabbing", borderClass, isDragging && "opacity-50")}
      {...attributes}
      {...listeners}
    >
      <CardHeader className="pb-2">
        <CardDescription>{card.id}</CardDescription>
        <CardTitle className="text-sm leading-snug">
          <button
            type="button"
            className="text-left hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              onOpenIssue?.(card.id);
            }}
          >
            {card.title}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{card.projectCode}</Badge>
          <Badge className="bg-sky-100 text-sky-800 hover:bg-sky-100">{card.issueType}</Badge>
          <Badge
            className={cn(
              card.priority === "Highest"
                ? "bg-rose-200 text-rose-800"
                : card.priority === "High"
                ? "bg-rose-100 text-rose-700"
                : card.priority === "Medium"
                  ? "bg-amber-100 text-amber-700"
                  : card.priority === "Low"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-sky-100 text-sky-700"
            )}
          >
            {card.priority}
          </Badge>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>{card.assignee}</span>
          <span>{card.id}</span>
        </div>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={(event) => {
              event.stopPropagation();
              onOpenIssue?.(card.id);
            }}
          >
            Details
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function KanbanColumnView({
  column,
  onOpenIssue,
}: {
  column: KanbanColumn;
  onOpenIssue: (issueKey: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: column.id });
  const borderClass = getKanbanBorderClass(column.id);
  return (
    <div ref={setNodeRef} className="space-y-2 rounded-xl border bg-muted/30 p-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="font-semibold">{column.title}</h3>
        <Badge variant="secondary">{column.cards.length}</Badge>
      </div>
      <SortableContext items={column.cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {column.cards.map((card) => (
            <SortableCardItem key={card.id} card={card} borderClass={borderClass} onOpenIssue={onOpenIssue} />
          ))}
          {column.cards.length === 0 && (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">Drop tasks here</div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function SidebarContent({
  active,
  setActive,
  collapsed,
}: {
  active: string;
  setActive: (id: string) => void;
  collapsed: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col justify-between">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
        <div className="flex items-center gap-2 px-1 py-1">
          <div className="grid h-8 w-8 place-content-center rounded-lg bg-primary/15 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          {!collapsed && <p className="text-sm font-semibold tracking-tight">AgenticOS</p>}
        </div>

        <div className="space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className={cn(
                  "group flex w-full items-center rounded-lg py-2 text-left text-sm transition",
                  collapsed ? "justify-center px-0" : "gap-2 px-2",
                  isActive ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isActive ? "text-sky-500 dark:text-sky-400" : "text-muted-foreground"
                  )}
                />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {!collapsed && (
        <div className="mt-2 shrink-0 space-y-2 rounded-lg border bg-muted/20 p-2">
          <p className="text-xs font-medium text-muted-foreground">Settings</p>
          <p className="text-xs text-muted-foreground">Click arrow to open. Auto-collapses when unpinned and mouse leaves.</p>
          <Badge variant="secondary" className="w-full justify-center">
            {AUTH_ENABLED ? "Auth Enabled" : "Auth Disabled"}
          </Badge>
        </div>
      )}
    </div>
  );
}

function CalendarBoard({
  cursor,
  setCursor,
  selectedDate,
  setSelectedDate,
  view,
  setView,
  events,
}: {
  cursor: Date;
  setCursor: (date: Date) => void;
  selectedDate: Date;
  setSelectedDate: (date: Date) => void;
  view: "month" | "week";
  setView: (view: "month" | "week") => void;
  events: CalendarEvent[];
}) {
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [detailDay, setDetailDay] = useState(selectedDate);

  const getEventsForDay = (day: Date) => {
    return events
      .filter((event) => isSameDay(new Date(event.eventTime), day))
      .sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime())
      .map((event) => ({
        task: event.title,
        time: format(new Date(event.eventTime), "HH:mm"),
        owner: event.owner,
        state: event.state,
        details: event.details,
      }));
  };

  const selectedEvents = getEventsForDay(selectedDate);

  const range = useMemo(() => {
    if (view === "week") {
      const start = startOfWeek(cursor, { weekStartsOn: 1 });
      return Array.from({ length: 7 }, (_, idx) => addDays(start, idx));
    }
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 });
    const days: Date[] = [];
    let current = start;
    while (current <= end) {
      days.push(current);
      current = addDays(current, 1);
    }
    return days;
  }, [cursor, view]);

  const goPrev = () => setCursor(view === "month" ? subMonths(cursor, 1) : subWeeks(cursor, 1));
  const goNext = () => setCursor(view === "month" ? addMonths(cursor, 1) : addWeeks(cursor, 1));
  const weekLabel = `${format(range[0], "dd.MM")}-${format(range[6], "dd.MM")} | CW ${getISOWeek(range[0])}`;

  return (
    <Card className="min-h-[76vh]">
      <CardHeader className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" onClick={goPrev}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="outline" onClick={goNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="text-center">
          <CardTitle>{view === "month" ? `Month - ${format(cursor, "MMMM yyyy")}` : `Week - ${weekLabel}`}</CardTitle>
          <CardDescription>{view === "month" ? "Month view" : "Week view"}</CardDescription>
        </div>

        <div className="flex items-center justify-end gap-2">
          <div className="rounded-md border p-0.5">
            <Button size="sm" variant={view === "week" ? "default" : "ghost"} onClick={() => setView("week")}>
              Week
            </Button>
            <Button size="sm" variant={view === "month" ? "default" : "ghost"} onClick={() => setView("month")}>
              Month
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={cn("grid border", view === "month" ? "grid-cols-7" : "grid-cols-7")}>
          {weekDayLabels.map((day) => (
            <div key={day} className="border-b bg-muted/40 py-2 text-center text-xs font-semibold text-muted-foreground">
              {day}
            </div>
          ))}

          {range.map((day) => {
            const isActiveDay = isSameDay(day, selectedDate);
            const isCurrentMonthDay = isSameMonth(day, cursor);
            return (
              <button
                key={day.toISOString()}
                onClick={() => {
                  setSelectedDate(day);
                  setDetailDay(day);
                  setDayModalOpen(true);
                }}
                className={cn(
                  "border-r border-b p-2 text-left transition last:border-r-0",
                  view === "month" ? "min-h-24" : "min-h-32",
                  isActiveDay ? "bg-primary/10 ring-1 ring-primary/50" : "hover:bg-muted/30",
                  !isCurrentMonthDay && view === "month" ? "text-muted-foreground" : "text-foreground"
                )}
              >
                <div className="text-xs font-semibold">{format(day, view === "month" ? "dd" : "EEE dd")}</div>
                <div className="mt-2 space-y-1">
                  {getEventsForDay(day).slice(0, view === "month" ? 1 : 2).map((event) => (
                    <div key={`${event.task}-${day.toISOString()}`} className="flex items-center gap-1.5 text-[10px]">
                      <StatusLed state={event.state} />
                      <span className="truncate">{event.time}</span>
                    </div>
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Planned Events for {format(selectedDate, "EEE, dd MMM yyyy")}</CardTitle>
            <CardDescription>Click any day to inspect event times and details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {selectedEvents.map((event) => (
              <div key={`${event.task}-${event.time}`} className="flex items-center justify-between rounded-md border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusLed state={event.state} />
                  <span>{event.time}</span>
                  <span className="text-muted-foreground">• {event.task}</span>
                </div>
                <span className="text-xs text-muted-foreground">{event.owner}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Dialog open={dayModalOpen} onOpenChange={setDayModalOpen}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Day View - {format(detailDay, "EEEE, dd MMM yyyy")}</DialogTitle>
              <DialogDescription>Planned events and times for the selected day</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {getEventsForDay(detailDay).map((event) => (
                <div key={`${event.task}-${event.time}`} className="flex items-center justify-between rounded-md border p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <StatusLed state={event.state} />
                    <span className="font-medium">{event.time}</span>
                    <span className="text-muted-foreground">• {event.task}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{event.owner}</span>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export function OpenclawDashboard() {
  const isSupabaseConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [hydrated, setHydrated] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authCardsVisible, setAuthCardsVisible] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [dashboardNotice, setDashboardNotice] = useState<{ type: "error" | "success"; message: string } | null>(null);
  const [toasts, setToasts] = useState<DashboardToast[]>([]);
  const [connectionHealth, setConnectionHealth] = useState<"checking" | "healthy" | "down">("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [isSidebarPinned, setIsSidebarPinned] = useState(false);
  const [isSidebarHovered, setIsSidebarHovered] = useState(false);
  const [isSidebarOpenedByButton, setIsSidebarOpenedByButton] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [calendarCursor, setCalendarCursor] = useState(new Date());
  const [calendarView, setCalendarView] = useState<"month" | "week">("month");
  const [darkMode, setDarkMode] = useState(true);
  const [healthHoverOpen, setHealthHoverOpen] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [gatewayPassword, setGatewayPassword] = useState("");
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayConnected, setGatewayConnected] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<string>("Not connected");
  const [gatewayNodes, setGatewayNodes] = useState<AgentProfile[]>([]);
  const [gatewaySessions, setGatewaySessions] = useState<GatewaySessionEntry[]>([]);
  const [gatewayAgents, setGatewayAgents] = useState<GatewayAgentEntry[]>([]);
  const [gatewayAgentId, setGatewayAgentId] = useState("");
  const [gatewayAgentName, setGatewayAgentName] = useState("");
  const [gatewayAgentWorkspace, setGatewayAgentWorkspace] = useState("");
  const [gatewayDocPath, setGatewayDocPath] = useState("SOUL.md");
  const [gatewayDocContent, setGatewayDocContent] = useState("");
  const [gatewayDocReadMethod, setGatewayDocReadMethod] = useState("workspace.read");
  const [gatewayDocWriteMethod, setGatewayDocWriteMethod] = useState("workspace.write");

  const [tasks, setTasks] = useState<Task[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);

  const [activeDragCard, setActiveDragCard] = useState<KanbanCard | null>(null);
  const [activeDragColumnId, setActiveDragColumnId] = useState<LaneId>("backlog");
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [issueDetailsOpen, setIssueDetailsOpen] = useState(false);

  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingIssueKey, setEditingIssueKey] = useState<string | null>(null);
  const [expandedTaskCardId, setExpandedTaskCardId] = useState<string | null>(null);
  const [expandedIssueCardId, setExpandedIssueCardId] = useState<string | null>(null);
  const [projectDeleteDialogOpen, setProjectDeleteDialogOpen] = useState(false);
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project | null>(null);
  const avatarMenuRef = useRef<HTMLDivElement | null>(null);
  const toastCounterRef = useRef(0);

  const [newTask, setNewTask] = useState({
    title: "",
    description: "",
    project: "AgenticOS Core",
    agent: initialAgentProfiles[0].name,
    priority: "Medium" as Task["priority"],
    status: "Todo" as Task["status"],
    resolvedAt: null as string | null,
    tagIds: [] as string[],
  });
  const [newIssue, setNewIssue] = useState({
    title: "",
    description: "",
    projectCode: "OC",
    owner: initialAgentProfiles[0].name,
    reporter: initialAgentProfiles[1].name,
    issueType: "Bug" as IssueType,
    priority: "Medium" as Priority,
    storyPoints: 0,
    acceptanceCriteria: "",
    resolvedAt: null as string | null,
    tagIds: [] as string[],
  });
  const [newProject, setNewProject] = useState({
    code: "",
    title: "",
    description: "",
    docs: "",
    instruction: "",
    manager: initialAgentProfiles[0].name,
    tagIds: [] as string[],
  });
  const [selectedAgentName, setSelectedAgentName] = useState(initialAgentProfiles[0].name);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }));

  useEffect(() => {
    let mounted = true;
    const initAuth = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!mounted) return;
      if (error) {
        setAuthError(error.message);
      }
      const session = data.session;
      setUserId(session?.user.id ?? null);
      setUserEmail(session?.user.email ?? "");
      setAuthReady(true);
    };
    void initAuth();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user.id ?? null);
      setUserEmail(session?.user.email ?? "");
      setAuthReady(true);
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  useEffect(() => {
    const raw = window.localStorage.getItem("agenticos.gateway.settings");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        url?: string;
        readMethod?: string;
        writeMethod?: string;
      };
      setGatewayUrl(parsed.url ?? "");
      setGatewayDocReadMethod(parsed.readMethod ?? "workspace.read");
      setGatewayDocWriteMethod(parsed.writeMethod ?? "workspace.write");
    } catch {
      // ignore malformed local settings
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      "agenticos.gateway.settings",
      JSON.stringify({
        url: gatewayUrl,
        readMethod: gatewayDocReadMethod,
        writeMethod: gatewayDocWriteMethod,
      })
    );
  }, [gatewayUrl, gatewayDocReadMethod, gatewayDocWriteMethod]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const checkConnection = async () => {
      const { error } = await supabase.from("projects").select("id").limit(1);
      if (cancelled) return;
      setConnectionHealth(error ? "down" : "healthy");
    };
    void checkConnection();
    const timer = window.setInterval(() => {
      void checkConnection();
    }, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [supabase, userId]);

  useEffect(() => {
    if (!userId) return;

    const loadData = async () => {
      setHydrated(false);
      const [tagsRes, projectsRes, tasksRes, issuesRes, eventsRes] = await Promise.all([
        supabase.from("tags").select("id,label,color").order("created_at", { ascending: true }),
        supabase.from("projects").select("id,code,title,description,docs,instruction,manager,tag_ids").order("created_at", { ascending: true }),
        supabase.from("tasks").select("id,title,description,project,agent,priority,status,resolved_at,tag_ids").order("created_at", { ascending: false }),
        supabase
          .from("issues")
          .select("key,sequence,title,description,issue_type,priority,owner,reporter,story_points,acceptance_criteria,lane,order_index,resolved_at,project_code,project_name,tag_ids")
          .order("created_at", { ascending: false }),
        supabase.from("calendar_events").select("id,title,event_time,owner,state,details").order("event_time", { ascending: true }),
      ]);

      const loadError =
        tagsRes.error?.message ??
        projectsRes.error?.message ??
        tasksRes.error?.message ??
        issuesRes.error?.message ??
        eventsRes.error?.message ??
        null;
      if (loadError) {
        setDashboardNotice({ type: "error", message: `Data load issue: ${loadError}` });
      }

      const tagRows = (tagsRes.data as { id: string; label: string; color: string }[] | null) ?? [];
      const projectRows =
        (projectsRes.data as {
          id: string;
          code: string;
          title: string;
          description: string;
          docs: unknown;
          instruction: string;
          manager: string;
          tag_ids: string[] | null;
        }[] | null) ?? [];
      const taskRows =
        (tasksRes.data as {
          id: string;
          title: string;
          description: string;
          project: string;
          agent: string;
          priority: string;
          status: string;
          resolved_at: string | null;
          tag_ids: string[] | null;
        }[] | null) ?? [];
      const issueRows =
        (issuesRes.data as {
          key: string;
          sequence: number;
          title: string;
          description: string;
          issue_type: string;
          priority: string;
          owner: string;
          reporter: string;
          story_points: number;
          acceptance_criteria: string;
          lane: string;
          order_index: number;
          resolved_at: string | null;
          project_code: string;
          project_name: string;
          tag_ids: string[] | null;
        }[] | null) ?? [];
      const eventRows =
        (eventsRes.data as {
          id: string;
          title: string;
          event_time: string;
          owner: string;
          state: string;
          details: string;
        }[] | null) ?? [];

      setTags(tagRows.map((row) => ({ id: row.id, label: row.label, color: row.color })));
      setProjects(
        projectRows.map((row) => ({
          id: row.id,
          code: row.code,
          title: row.title,
          description: row.description,
          docs: Array.isArray(row.docs) ? row.docs.map((item) => String(item)) : [],
          instruction: row.instruction,
          manager: row.manager,
          tagIds: row.tag_ids ?? [],
        }))
      );
      if (projectRows.length > 0) {
        const firstProject = projectRows[0];
        setNewIssue((prev) => {
          const exists = projectRows.some((project) => project.code === prev.projectCode);
          return exists ? prev : { ...prev, projectCode: firstProject.code };
        });
        setNewTask((prev) => {
          const exists = projectRows.some((project) => project.title === prev.project);
          return exists ? prev : { ...prev, project: firstProject.title };
        });
      }
      setTasks(
        taskRows.map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          project: row.project,
          agent: row.agent,
          priority: row.priority as Task["priority"],
          status: row.status as Task["status"],
          resolvedAt: row.resolved_at,
          tagIds: row.tag_ids ?? [],
        }))
      );
      setIssues(
        issueRows.map((row) => ({
          key: row.key,
          sequence: row.sequence,
          title: row.title,
          description: row.description,
          issueType: row.issue_type as IssueType,
          priority: row.priority as Priority,
          owner: row.owner,
          reporter: row.reporter,
          storyPoints: row.story_points,
          acceptanceCriteria: row.acceptance_criteria,
          lane: row.lane as LaneId,
          order: row.order_index,
          resolvedAt: row.resolved_at,
          projectCode: row.project_code,
          projectName: row.project_name,
          tagIds: row.tag_ids ?? [],
        }))
      );
      setAgents((prev) => (prev.length > 0 ? prev : initialAgentProfiles));
      setCalendarEvents(
        eventRows.map((row) => ({
          id: row.id,
          title: row.title,
          eventTime: row.event_time,
          owner: row.owner,
          state: row.state as CalendarEvent["state"],
          details: row.details,
        }))
      );
      setHydrated(true);
    };
    void loadData();
  }, [supabase, userId]);

  const toggleTheme = () => setDarkMode((prev) => !prev);
  const kanbanColumns = useMemo(() => buildKanbanColumnsFromIssues(issues), [issues]);

  const findColumnByCardIdOrColumn = (id: string, columns: KanbanColumn[]) => {
    return columns.find((column) => column.id === id) ?? columns.find((column) => column.cards.some((card) => card.id === id));
  };

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id);
    const column = findColumnByCardIdOrColumn(activeId, kanbanColumns);
    const card = column?.cards.find((entry) => entry.id === activeId) ?? null;
    setActiveDragCard(card);
    setActiveDragColumnId(column?.id ?? "backlog");
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;
    const overColumn = findColumnByCardIdOrColumn(overId, kanbanColumns);
    if (overColumn) setActiveDragColumnId(overColumn.id);

    setIssues((prev) => {
      const columns = buildKanbanColumnsFromIssues(prev);
      const activeColumn = findColumnByCardIdOrColumn(activeId, columns);
      const targetColumn = findColumnByCardIdOrColumn(overId, columns);
      if (!activeColumn || !targetColumn || activeColumn.id === targetColumn.id) return prev;

      const moved = prev.find((issue) => issue.key === activeId);
      if (!moved) return prev;

      const targetOrder =
        columns
          .find((column) => column.id === targetColumn.id)
          ?.cards.findIndex((card) => card.id === overId) ?? -1;
      const maxOrderInTarget = Math.max(
        -1,
        ...prev.filter((issue) => issue.lane === targetColumn.id).map((issue) => issue.order)
      );

      let next = prev.map((issue) =>
        issue.key === moved.key
          ? {
              ...issue,
              lane: targetColumn.id,
              order: targetOrder >= 0 ? targetOrder : maxOrderInTarget + 1,
              resolvedAt:
                targetColumn.id === "done" ? issue.resolvedAt ?? new Date().toISOString() : null,
            }
          : issue
      );
      next = normalizeLaneOrders(next, activeColumn.id);
      next = normalizeLaneOrders(next, targetColumn.id);
      return next;
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragCard(null);
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    setIssues((prev) => {
      const columns = buildKanbanColumnsFromIssues(prev);
      const activeColumn = findColumnByCardIdOrColumn(activeId, columns);
      const overColumn = findColumnByCardIdOrColumn(overId, columns);
      if (!activeColumn || !overColumn) return prev;
      if (activeColumn.id !== overColumn.id) {
        void (async () => {
          const results = await Promise.all(
            prev.map((issue) =>
              supabase
                .from("issues")
                .update({ lane: issue.lane, order_index: issue.order, resolved_at: issue.resolvedAt })
                .eq("key", issue.key)
            )
          );
          const failed = results.find((result) => result.error);
          if (failed?.error) {
            setDashboardNotice({ type: "error", message: `Issue order sync failed: ${failed.error.message}` });
          }
        })();
        return prev;
      }

      const laneIssues = prev
        .filter((issue) => issue.lane === activeColumn.id)
        .sort((a, b) => a.order - b.order);
      const oldIndex = laneIssues.findIndex((issue) => issue.key === activeId);
      const newIndex = laneIssues.findIndex((issue) => issue.key === overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const reordered = arrayMove(laneIssues, oldIndex, newIndex);
      const orderMap = new Map(reordered.map((issue, idx) => [issue.key, idx]));
      const next = prev.map((issue) =>
        issue.lane === activeColumn.id ? { ...issue, order: orderMap.get(issue.key) ?? issue.order } : issue
      );
      void (async () => {
        const results = await Promise.all(
          next.map((issue) =>
            supabase
              .from("issues")
              .update({ lane: issue.lane, order_index: issue.order, resolved_at: issue.resolvedAt })
              .eq("key", issue.key)
          )
        );
        const failed = results.find((result) => result.error);
        if (failed?.error) {
          setDashboardNotice({ type: "error", message: `Issue order sync failed: ${failed.error.message}` });
        }
      })();
      return next;
    });
  };

  const handleCreateTask = async () => {
    if (!userId) return;
    if (!newTask.title.trim()) {
      setDashboardNotice({ type: "error", message: "Task title is required." });
      return;
    }
    if (!newTask.description.trim()) {
      setDashboardNotice({ type: "error", message: "Task description is required." });
      return;
    }
    if (!newTask.agent) {
      setDashboardNotice({ type: "error", message: "Task agent is required." });
      return;
    }
    const validTaskProject = projects.find((project) => project.title === newTask.project) ?? projects[0];
    if (!validTaskProject) {
      setDashboardNotice({ type: "error", message: "Please create at least one project before creating tasks." });
      return;
    }
    const resolvedAt = newTask.status === "Done" ? new Date().toISOString() : null;
    const task: Task = {
      id: `T-${Date.now()}`,
      title: newTask.title.trim(),
      description: newTask.description.trim(),
      project: validTaskProject.title,
      agent: newTask.agent,
      priority: newTask.priority,
      status: newTask.status,
      resolvedAt,
      tagIds: newTask.tagIds,
    };
    const { error } = await supabase.from("tasks").insert({
      id: task.id,
      user_id: userId,
      title: task.title,
      description: task.description,
      project: task.project,
      agent: task.agent,
      priority: task.priority,
      status: task.status,
      resolved_at: resolvedAt,
      tag_ids: task.tagIds,
    });
    if (error) {
      setDashboardNotice({ type: "error", message: `Task creation failed: ${error.message}` });
      return;
    }
    setTasks((prev) => [task, ...prev]);
    setNewTask({ ...newTask, title: "", description: "", priority: "Medium", status: "Todo", resolvedAt: null, tagIds: [] });
    setTaskDialogOpen(false);
    setDashboardNotice({ type: "success", message: "Task created." });
  };

  const handleSaveTask = async () => {
    if (!userId || !editingTaskId) return;
    if (!newTask.title.trim()) {
      setDashboardNotice({ type: "error", message: "Task title is required." });
      return;
    }
    if (!newTask.description.trim()) {
      setDashboardNotice({ type: "error", message: "Task description is required." });
      return;
    }
    const resolvedAt =
      newTask.status === "Done" ? newTask.resolvedAt ?? new Date().toISOString() : null;
    const { error } = await supabase
      .from("tasks")
      .update({
        title: newTask.title.trim(),
        description: newTask.description.trim(),
        project: newTask.project,
        agent: newTask.agent,
        priority: newTask.priority,
        status: newTask.status,
        resolved_at: resolvedAt,
        tag_ids: newTask.tagIds,
      })
      .eq("id", editingTaskId);
    if (error) {
      setDashboardNotice({ type: "error", message: `Task update failed: ${error.message}` });
      return;
    }
    setTasks((prev) =>
      prev.map((task) =>
        task.id === editingTaskId
          ? {
              ...task,
              title: newTask.title.trim(),
              description: newTask.description.trim(),
              project: newTask.project,
              agent: newTask.agent,
              priority: newTask.priority,
              status: newTask.status,
              resolvedAt,
              tagIds: newTask.tagIds,
            }
          : task
      )
    );
    setEditingTaskId(null);
    setTaskDialogOpen(false);
    setDashboardNotice({ type: "success", message: "Task updated." });
  };

  const createTag = async (label: string, color: string) => {
    if (!userId) return null;
    const normalized = label.trim();
    if (!normalized) return null;
    const existing = tags.find((tag) => tag.label.toLowerCase() === normalized.toLowerCase());
    if (existing) return existing.id;
    const nextTag: Tag = { id: `tag-${Date.now()}`, label: normalized, color };
    const { error } = await supabase.from("tags").insert({
      id: nextTag.id,
      user_id: userId,
      label: nextTag.label,
      color: nextTag.color,
    });
    if (error) {
      setDashboardNotice({ type: "error", message: `Tag creation failed: ${error.message}` });
      return null;
    }
    setTags((prev) => [nextTag, ...prev]);
    return nextTag.id;
  };

  const handleCreateIssue = async () => {
    if (!userId) return;
    if (!newIssue.title.trim()) {
      setDashboardNotice({ type: "error", message: "Issue title is required." });
      return;
    }
    if (!newIssue.description.trim()) {
      setDashboardNotice({ type: "error", message: "Issue description is required." });
      return;
    }
    if (!newIssue.owner || !newIssue.reporter) {
      setDashboardNotice({ type: "error", message: "Issue owner and reporter are required." });
      return;
    }
    const project = projects.find((entry) => entry.code === newIssue.projectCode) ?? projects[0];
    if (!project) {
      setDashboardNotice({ type: "error", message: "Please create at least one project before creating issues." });
      return;
    }
    const nextSequence =
      Math.max(-1, ...issues.filter((issue) => issue.projectCode === project.code).map((issue) => issue.sequence)) +
      1;
    const key = `${project.code}-${String(nextSequence).padStart(3, "0")}`;
    const issue: Issue = {
      key,
      sequence: nextSequence,
      title: newIssue.title.trim(),
      description: newIssue.description.trim(),
      issueType: newIssue.issueType,
      priority: newIssue.priority,
      owner: newIssue.owner,
      reporter: newIssue.reporter,
      storyPoints: newIssue.storyPoints,
      acceptanceCriteria: newIssue.acceptanceCriteria.trim(),
      lane: "backlog",
      order: Math.max(-1, ...issues.filter((entry) => entry.lane === "backlog").map((entry) => entry.order)) + 1,
      resolvedAt: null,
      projectCode: project.code,
      projectName: project.title,
      tagIds: newIssue.tagIds,
    };
    const { error } = await supabase.from("issues").insert({
      key: issue.key,
      user_id: userId,
      sequence: issue.sequence,
      title: issue.title,
      description: issue.description,
      issue_type: issue.issueType,
      priority: issue.priority,
      owner: issue.owner,
      reporter: issue.reporter,
      story_points: issue.storyPoints,
      acceptance_criteria: issue.acceptanceCriteria,
      lane: issue.lane,
      order_index: issue.order,
      resolved_at: issue.resolvedAt,
      project_code: issue.projectCode,
      project_name: issue.projectName,
      tag_ids: issue.tagIds,
    });
    if (error) {
      setDashboardNotice({ type: "error", message: `Issue creation failed: ${error.message}` });
      return;
    }
    setIssues((prev) => [issue, ...prev]);
    setNewIssue({
      ...newIssue,
      title: "",
      description: "",
      issueType: "Bug",
      priority: "Medium",
      storyPoints: 0,
      acceptanceCriteria: "",
      resolvedAt: null,
      tagIds: [],
    });
    setIssueDialogOpen(false);
    setActiveTab("kanban");
    setDashboardNotice({ type: "success", message: "Issue created." });
  };

  const handleSaveIssue = async () => {
    if (!userId || !editingIssueKey) return;
    const project = projects.find((entry) => entry.code === newIssue.projectCode) ?? projects[0];
    if (!project) {
      setDashboardNotice({ type: "error", message: "Please create at least one project before updating issues." });
      return;
    }
    const resolvedAt = newIssue.resolvedAt;
    const { error } = await supabase
      .from("issues")
      .update({
        title: newIssue.title.trim(),
        description: newIssue.description.trim(),
        issue_type: newIssue.issueType,
        priority: newIssue.priority,
        owner: newIssue.owner,
        reporter: newIssue.reporter,
        story_points: newIssue.storyPoints,
        acceptance_criteria: newIssue.acceptanceCriteria.trim(),
        resolved_at: resolvedAt,
        project_code: project.code,
        project_name: project.title,
        tag_ids: newIssue.tagIds,
      })
      .eq("key", editingIssueKey);
    if (error) {
      setDashboardNotice({ type: "error", message: `Issue update failed: ${error.message}` });
      return;
    }
    setIssues((prev) =>
      prev.map((issue) =>
        issue.key === editingIssueKey
          ? {
              ...issue,
              title: newIssue.title.trim(),
              description: newIssue.description.trim(),
              issueType: newIssue.issueType,
              priority: newIssue.priority,
              owner: newIssue.owner,
              reporter: newIssue.reporter,
              storyPoints: newIssue.storyPoints,
              acceptanceCriteria: newIssue.acceptanceCriteria.trim(),
              resolvedAt,
              projectCode: project.code,
              projectName: project.title,
              tagIds: newIssue.tagIds,
            }
          : issue
      )
    );
    setEditingIssueKey(null);
    setIssueDialogOpen(false);
    setDashboardNotice({ type: "success", message: "Issue updated." });
  };

  const startEditTask = (task: Task) => {
    setEditingTaskId(task.id);
    setNewTask({
      title: task.title,
      description: task.description,
      project: task.project,
      agent: task.agent,
      priority: task.priority,
      status: task.status,
      resolvedAt: task.resolvedAt,
      tagIds: task.tagIds,
    });
    setTaskDialogOpen(true);
  };

  const startEditIssue = (issue: Issue) => {
    setEditingIssueKey(issue.key);
    setNewIssue({
      title: issue.title,
      description: issue.description,
      projectCode: issue.projectCode,
      owner: issue.owner,
      reporter: issue.reporter,
      issueType: issue.issueType,
      priority: issue.priority,
      storyPoints: issue.storyPoints,
      acceptanceCriteria: issue.acceptanceCriteria,
      resolvedAt: issue.resolvedAt,
      tagIds: issue.tagIds,
    });
    setIssueDialogOpen(true);
  };

  const updateTaskStatus = async (task: Task, nextStatus: Task["status"]) => {
    const previousStatus = task.status;
    const previousResolvedAt = task.resolvedAt;
    const resolvedAt = nextStatus === "Done" ? previousResolvedAt ?? new Date().toISOString() : null;
    setTasks((prev) => prev.map((entry) => (entry.id === task.id ? { ...entry, status: nextStatus, resolvedAt } : entry)));
    const { error } = await supabase
      .from("tasks")
      .update({ status: nextStatus, resolved_at: resolvedAt })
      .eq("id", task.id);
    if (error) {
      setTasks((prev) =>
        prev.map((entry) => (entry.id === task.id ? { ...entry, status: previousStatus, resolvedAt: previousResolvedAt } : entry))
      );
      setDashboardNotice({ type: "error", message: `Task status update failed: ${error.message}` });
      return;
    }
    setDashboardNotice({ type: "success", message: "Task status updated." });
  };

  const handleDeleteTask = async (task: Task) => {
    if (!userId) return;
    const previousTasks = tasks;
    setTasks((prev) => prev.filter((entry) => entry.id !== task.id));
    const { error } = await supabase.from("tasks").delete().eq("id", task.id);
    if (error) {
      setTasks(previousTasks);
      setDashboardNotice({ type: "error", message: `Task deletion failed: ${error.message}` });
      return;
    }
    pushToast({
      type: "success",
      message: `Task "${task.title}" deleted.`,
      actionLabel: "Undo",
      durationMs: 7000,
      onAction: () => {
        void (async () => {
          const { error: undoError } = await supabase.from("tasks").insert({
            id: task.id,
            user_id: userId,
            title: task.title,
            description: task.description,
            project: task.project,
            agent: task.agent,
            priority: task.priority,
            status: task.status,
            resolved_at: task.resolvedAt,
            tag_ids: task.tagIds,
          });
          if (undoError) {
            pushToast({ type: "error", message: `Undo failed: ${undoError.message}` });
            return;
          }
          setTasks((prev) => (prev.some((entry) => entry.id === task.id) ? prev : [task, ...prev]));
          pushToast({ type: "success", message: "Task restored." });
        })();
      },
    });
  };

  const updateIssueLane = async (issue: Issue, nextLane: LaneId) => {
    const previousLane = issue.lane;
    const previousResolvedAt = issue.resolvedAt;
    const resolvedAt = nextLane === "done" ? previousResolvedAt ?? new Date().toISOString() : null;
    setIssues((prev) =>
      prev.map((entry) =>
        entry.key === issue.key
          ? {
              ...entry,
              lane: nextLane,
              resolvedAt,
            }
          : entry
      )
    );
    const { error } = await supabase.from("issues").update({ lane: nextLane, resolved_at: resolvedAt }).eq("key", issue.key);
    if (error) {
      setIssues((prev) =>
        prev.map((entry) =>
          entry.key === issue.key
            ? {
                ...entry,
                lane: previousLane,
                resolvedAt: previousResolvedAt,
              }
            : entry
        )
      );
      setDashboardNotice({ type: "error", message: `Issue status update failed: ${error.message}` });
      return;
    }
    setDashboardNotice({ type: "success", message: `Issue ${issue.key} updated.` });
  };

  const handleDeleteIssue = async (issue: Issue) => {
    if (!userId) return;
    const previousIssues = issues;
    setIssues((prev) => prev.filter((entry) => entry.key !== issue.key));
    const { error } = await supabase.from("issues").delete().eq("key", issue.key);
    if (error) {
      setIssues(previousIssues);
      setDashboardNotice({ type: "error", message: `Issue deletion failed: ${error.message}` });
      return;
    }
    pushToast({
      type: "success",
      message: `Issue ${issue.key} deleted.`,
      actionLabel: "Undo",
      durationMs: 7000,
      onAction: () => {
        void (async () => {
          const { error: undoError } = await supabase.from("issues").insert({
            key: issue.key,
            user_id: userId,
            sequence: issue.sequence,
            title: issue.title,
            description: issue.description,
            issue_type: issue.issueType,
            priority: issue.priority,
            owner: issue.owner,
            reporter: issue.reporter,
            story_points: issue.storyPoints,
            acceptance_criteria: issue.acceptanceCriteria,
            lane: issue.lane,
            order_index: issue.order,
            resolved_at: issue.resolvedAt,
            project_code: issue.projectCode,
            project_name: issue.projectName,
            tag_ids: issue.tagIds,
          });
          if (undoError) {
            pushToast({ type: "error", message: `Undo failed: ${undoError.message}` });
            return;
          }
          setIssues((prev) => (prev.some((entry) => entry.key === issue.key) ? prev : [issue, ...prev]));
          pushToast({ type: "success", message: `Issue ${issue.key} restored.` });
        })();
      },
    });
  };

  const requestDeleteProject = (project: Project) => {
    setProjectDeleteTarget(project);
    setProjectDeleteDialogOpen(true);
  };

  const confirmDeleteProject = async () => {
    if (!projectDeleteTarget) return;
    const project = projectDeleteTarget;
    const { error: issuesError } = await supabase.from("issues").delete().eq("project_code", project.code);
    if (issuesError) {
      setDashboardNotice({ type: "error", message: `Project issue cleanup failed: ${issuesError.message}` });
      return;
    }
    const { error: projectError } = await supabase.from("projects").delete().eq("id", project.id);
    if (projectError) {
      setDashboardNotice({ type: "error", message: `Project deletion failed: ${projectError.message}` });
      return;
    }
    setIssues((prev) => prev.filter((issue) => issue.projectCode !== project.code));
    setProjects((prev) => prev.filter((entry) => entry.id !== project.id));
    setProjectDeleteDialogOpen(false);
    setProjectDeleteTarget(null);
    setDashboardNotice({ type: "success", message: `Project ${project.code} deleted with its issues.` });
  };

  const handleCreateProject = async () => {
    if (!userId) return;
    const cleanCode = newProject.code.trim().toUpperCase();
    if (!cleanCode) {
      setDashboardNotice({ type: "error", message: "Project code is required." });
      return;
    }
    if (!newProject.title.trim()) {
      setDashboardNotice({ type: "error", message: "Project title is required." });
      return;
    }
    if (!newProject.manager) {
      setDashboardNotice({ type: "error", message: "Project manager agent is required." });
      return;
    }
    if (projects.some((project) => project.code === cleanCode)) {
      setDashboardNotice({ type: "error", message: `Project code ${cleanCode} already exists.` });
      return;
    }
    const project: Project = {
      id: `p-${Date.now()}`,
      code: cleanCode,
      title: newProject.title.trim(),
      description: newProject.description.trim() || "No description yet.",
      docs: newProject.docs.split("\n").map((entry) => entry.trim()).filter(Boolean),
      instruction: newProject.instruction.trim() || "No instruction yet.",
      manager: newProject.manager,
      tagIds: newProject.tagIds,
    };
    const { error } = await supabase.from("projects").insert({
      id: project.id,
      user_id: userId,
      code: project.code,
      title: project.title,
      description: project.description,
      docs: project.docs,
      instruction: project.instruction,
      manager: project.manager,
      tag_ids: project.tagIds,
    });
    if (error) {
      setDashboardNotice({ type: "error", message: `Project creation failed: ${error.message}` });
      return;
    }
    setProjects((prev) => [project, ...prev]);
    setNewProject({ ...newProject, code: "", title: "", description: "", docs: "", instruction: "", tagIds: [] });
    setProjectDialogOpen(false);
    setDashboardNotice({ type: "success", message: "Project created." });
  };

  const boardStats = useMemo(() => {
    const totalCards = kanbanColumns.reduce((sum, column) => sum + column.cards.length, 0);
    const doneCards = kanbanColumns.find((column) => column.id === "done")?.cards.length ?? 0;
    const completionRate = totalCards ? Math.round((doneCards / totalCards) * 100) : 0;
    return [
      { label: "Agents", value: `${agents.length}`, detail: "Registered agents" },
      {
        label: "Open Sessions",
        value: `${gatewayConnected ? gatewaySessions.length : 31}`,
        detail: gatewayConnected ? "Gateway live sessions" : "Mock live sessions",
      },
      { label: "Board Cards", value: `${totalCards}`, detail: `${completionRate}% done` },
      { label: "Issues", value: `${issues.length}`, detail: "Synced into board flow" },
    ];
  }, [issues.length, kanbanColumns, agents.length, gatewayConnected, gatewaySessions.length]);

  const laneSegments = useMemo<PieSegment[]>(
    () =>
      kanbanColumns.map((column, idx) => ({
        label: column.title,
        value: column.cards.length,
        color: ["#2563eb", "#f59e0b", "#8b5cf6", "#10b981"][idx % 4],
      })),
    [kanbanColumns]
  );

  const severitySegments = useMemo<PieSegment[]>(() => {
    const bySeverity = { Highest: 0, High: 0, Medium: 0, Low: 0, Lowest: 0 };
    issues.forEach((issue) => {
      bySeverity[issue.priority] += 1;
    });
    return [
      { label: "Highest", value: bySeverity.Highest, color: "#b91c1c" },
      { label: "High", value: bySeverity.High, color: "#ef4444" },
      { label: "Medium", value: bySeverity.Medium, color: "#f59e0b" },
      { label: "Low", value: bySeverity.Low, color: "#22c55e" },
      { label: "Lowest", value: bySeverity.Lowest, color: "#0284c7" },
    ];
  }, [issues]);

  const taskSegments = useMemo<PieSegment[]>(() => {
    const byStatus = { Todo: 0, "In Progress": 0, Done: 0 };
    tasks.forEach((task) => {
      byStatus[task.status] += 1;
    });
    return [
      { label: "Todo", value: byStatus.Todo, color: "#64748b" },
      { label: "In Progress", value: byStatus["In Progress"], color: "#3b82f6" },
      { label: "Done", value: byStatus.Done, color: "#10b981" },
    ];
  }, [tasks]);

  const projectOptions = projects.map((project) => ({ code: project.code, title: project.title }));
  const agentNames = agents.map((agent) => agent.name);
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const selectedAgent = agents.find((agent) => agent.name === selectedAgentName) ?? agents[0];
  const isSidebarExpanded = isSidebarPinned || isSidebarOpenedByButton;
  const selectedIssue = issues.find((issue) => issue.key === selectedIssueKey) ?? null;
  const todoTasks = tasks.filter((task) => task.status === "Todo");
  const inProgressTasks = tasks.filter((task) => task.status === "In Progress");
  const resolvedTasks = tasks.filter((task) => task.status === "Done" && task.resolvedAt);
  const backlogIssues = issues.filter((issue) => issue.lane === "backlog");
  const inProgressIssues = issues.filter((issue) => issue.lane === "in-progress");
  const reviewIssues = issues.filter((issue) => issue.lane === "review");
  const resolvedIssues = issues.filter((issue) => issue.lane === "done" && issue.resolvedAt);

  const groupByResolvedDay = <T extends { resolvedAt: string | null }>(items: T[]) => {
    const groups = items.reduce<Record<string, T[]>>((acc, item) => {
      if (!item.resolvedAt) return acc;
      const day = format(new Date(item.resolvedAt), "yyyy-MM-dd");
      if (!acc[day]) acc[day] = [];
      acc[day].push(item);
      return acc;
    }, {});
    return Object.entries(groups).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  };

  const resolvedTaskGroups = groupByResolvedDay(resolvedTasks);
  const resolvedIssueGroups = groupByResolvedDay(resolvedIssues);
  const deleteImpactIssueCount = projectDeleteTarget
    ? issues.filter((issue) => issue.projectCode === projectDeleteTarget.code).length
    : 0;
  const renderTaskCard = (task: Task) => {
    const expanded = expandedTaskCardId === task.id;
    return (
      <div
        key={task.id}
        className="rounded-lg border bg-muted/25 p-2.5 transition hover:bg-muted/35 dark:bg-slate-800/45 dark:hover:bg-slate-800/60"
      >
        <button
          type="button"
          onClick={() => setExpandedTaskCardId((prev) => (prev === task.id ? null : task.id))}
          className="flex w-full items-center justify-between gap-2 pr-1 text-left"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{task.title}</p>
          </div>
          <div className="flex items-center justify-end">
            <StatusLed state={statusLedFromTaskStatus(task.status)} title={statusMeaningFromTaskStatus(task.status)} />
          </div>
        </button>
        {expanded && (
          <div className="mt-2 space-y-2 border-t pt-2 text-xs">
            <p className="text-muted-foreground">{task.description}</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{task.project}</Badge>
              <Badge variant="secondary">{task.agent}</Badge>
              <Badge variant="outline">{task.priority}</Badge>
              {task.tagIds.map((tagId) => {
                const tag = tagById.get(tagId);
                if (!tag) return null;
                return (
                  <Badge key={tag.id} className="text-white" style={{ backgroundColor: tag.color }}>
                    {tag.label}
                  </Badge>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <select
                value={task.status}
                onChange={(event) => void updateTaskStatus(task, event.target.value as Task["status"])}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option>Todo</option>
                <option>In Progress</option>
                <option>Done</option>
              </select>
              <Button size="sm" variant="outline" onClick={() => startEditTask(task)}>
                Edit
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void handleDeleteTask(task)}>
                Delete
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };
  const renderIssueCard = (issue: Issue) => {
    const expanded = expandedIssueCardId === issue.key;
    const laneAccentClass =
      issue.lane === "in-progress"
        ? "border-l-amber-400"
        : issue.lane === "review"
          ? "border-l-violet-500"
          : issue.lane === "done"
            ? "border-l-emerald-500"
            : "border-l-zinc-400";
    return (
      <div
        key={issue.key}
        className={cn(
          "rounded-lg border border-l-4 bg-muted/25 p-2.5 transition hover:bg-muted/35 dark:bg-slate-800/45 dark:hover:bg-slate-800/60",
          laneAccentClass
        )}
      >
        <button
          type="button"
          onClick={() => setExpandedIssueCardId((prev) => (prev === issue.key ? null : issue.key))}
          className="flex w-full items-center justify-between gap-2 pr-1 text-left"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="outline">{issue.key}</Badge>
            <p className="truncate text-sm font-semibold leading-tight">{issue.title}</p>
          </div>
          <div className="flex items-center justify-end">
            <StatusLed state={statusLedFromIssueLane(issue.lane)} title={statusMeaningFromIssueLane(issue.lane)} />
          </div>
        </button>
        {expanded && (
          <div className="mt-2 space-y-2 border-t pt-2 text-xs">
            <p className="text-muted-foreground">{issue.description}</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">Priority: {issue.priority}</Badge>
              <Badge variant="secondary">Owner: {issue.owner}</Badge>
              <Badge variant="secondary">Reporter: {issue.reporter}</Badge>
              <Badge variant="outline">{issue.projectCode}</Badge>
              <Badge className="bg-sky-100 text-sky-800 hover:bg-sky-100">{issue.issueType}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {issue.tagIds.map((tagId) => {
                const tag = tagById.get(tagId);
                if (!tag) return null;
                return (
                  <Badge key={tag.id} className="text-white" style={{ backgroundColor: tag.color }}>
                    {tag.label}
                  </Badge>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <select
                value={issue.lane}
                onChange={(event) => void updateIssueLane(issue, event.target.value as LaneId)}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option value="backlog">Backlog</option>
                <option value="in-progress">In Progress</option>
                <option value="review">Review</option>
                <option value="done">Done</option>
              </select>
              <Button size="sm" variant="outline" onClick={() => startEditIssue(issue)}>
                Edit
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void handleDeleteIssue(issue)}>
                Delete
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };
  const marketingCards: Array<{
    title: string;
    text: string;
    icon: ComponentType<{ className?: string }>;
  }> = [
    { title: "Live Agent Telemetry", text: "Track readiness, runtime state, and operational health in one pane.", icon: Activity },
    { title: "Kanban + Issue Flow", text: "Move work through backlog, in-progress, review, and done with context.", icon: FolderKanban },
    { title: "Task Execution Layer", text: "Plan priorities, ownership, and completion with clear accountability.", icon: ListChecks },
    { title: "Calendar Scheduling", text: "Coordinate cron events and planned runs with timeline visibility.", icon: CalendarClock },
  ];
  const openclawHealth = useMemo<"healthy" | "warning" | "down">(() => {
    if (!agents.length) return "down";
    const downCount = agents.filter((agent) => agent.state === "down").length;
    if (downCount === 0) return "healthy";
    if (downCount === agents.length) return "down";
    return "warning";
  }, [agents]);
  const combinedHealth = useMemo<"healthy" | "warning" | "down">(() => {
    const dbDown = connectionHealth === "down";
    const ocDown = openclawHealth === "down";
    const dbHealthy = connectionHealth === "healthy";
    const ocHealthy = openclawHealth === "healthy";
    if (dbHealthy && ocHealthy) return "healthy";
    if (dbDown && ocDown) return "down";
    return "warning";
  }, [connectionHealth, openclawHealth]);
  const dbConnected = connectionHealth === "healthy";
  const openclawConnected = openclawHealth === "healthy";
  useEffect(() => {
    const timer = window.setTimeout(() => setAuthCardsVisible(true), 50);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!avatarMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(target)) {
        setAvatarMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [avatarMenuOpen]);

  const pushToast = ({
    type,
    message,
    actionLabel,
    onAction,
    durationMs = 4000,
  }: {
    type: "success" | "error";
    message: string;
    actionLabel?: string;
    onAction?: () => void;
    durationMs?: number;
  }) => {
    const id = ++toastCounterRef.current;
    setToasts((prev) => [...prev, { id, type, message, actionLabel, onAction }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, durationMs);
  };

  useEffect(() => {
    if (!dashboardNotice) return;
    pushToast({
      type: dashboardNotice.type,
      message: dashboardNotice.message,
      durationMs: dashboardNotice.type === "error" ? 5200 : 3600,
    });
    const clearTimer = window.setTimeout(() => setDashboardNotice(null), 0);
    return () => window.clearTimeout(clearTimer);
  }, [dashboardNotice]);

  const gatewayApi = async <T,>(route: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { ok?: boolean; error?: string } & T;
    if (!response.ok || json.ok === false) {
      throw new Error(json.error || "Gateway request failed");
    }
    return json as T;
  };

  const syncGatewayBootstrap = async () => {
    if (!gatewayUrl.trim()) {
      setDashboardNotice({ type: "error", message: "Please enter a gateway WebSocket URL." });
      return;
    }
    setGatewayLoading(true);
    try {
      const result = await gatewayApi<{ data: Record<string, unknown> }>("/api/openclaw/gateway/bootstrap", {
        url: gatewayUrl.trim(),
        token: gatewayToken.trim() || undefined,
        password: gatewayPassword.trim() || undefined,
      });

      const data = result.data ?? {};
      const statusPayload = (data.status ?? {}) as Record<string, unknown>;
      const statusLabel =
        typeof statusPayload.mode === "string"
          ? `${statusPayload.mode} (${String(statusPayload.pairing ?? "pairing unknown")})`
          : "Connected";

      const nodePayload = (data.nodes ?? {}) as Record<string, unknown>;
      const nodeItems = Array.isArray(nodePayload.items)
        ? nodePayload.items
        : Array.isArray(nodePayload.nodes)
          ? nodePayload.nodes
          : Array.isArray(data.nodes)
            ? (data.nodes as unknown[])
            : [];
      const mappedNodes: AgentProfile[] = nodeItems.map((item, idx) => {
        const row = item as Record<string, unknown>;
        const stateRaw = String(row.state ?? row.health ?? "").toLowerCase();
        const healthy = stateRaw && stateRaw !== "down" && stateRaw !== "error";
        const running = stateRaw.includes("run") || stateRaw.includes("busy");
        return {
          name: String(row.id ?? row.name ?? row.nodeId ?? `node-${idx + 1}`),
          state: !healthy ? "down" : running ? "running" : "ready",
          info: String(row.label ?? row.state ?? row.health ?? "Gateway node"),
          logs: [],
        };
      });

      const sessionsPayload = (data.sessions ?? {}) as Record<string, unknown>;
      const sessionItems = Array.isArray(sessionsPayload.items)
        ? sessionsPayload.items
        : Array.isArray(sessionsPayload.sessions)
          ? sessionsPayload.sessions
          : Array.isArray(data.sessions)
            ? (data.sessions as unknown[])
            : [];
      const mappedSessions: GatewaySessionEntry[] = sessionItems.map((item) => {
        const row = item as Record<string, unknown>;
        return {
          id: typeof row.id === "string" ? row.id : undefined,
          key: typeof row.key === "string" ? row.key : undefined,
          state: typeof row.state === "string" ? row.state : undefined,
        };
      });

      setGatewayNodes(mappedNodes);
      setGatewaySessions(mappedSessions);
      if (mappedNodes.length > 0) {
        setAgents(mappedNodes);
        setSelectedAgentName(mappedNodes[0].name);
      }
      setGatewayStatus(statusLabel);
      setGatewayConnected(true);
      await loadGatewayAgents();
      setDashboardNotice({ type: "success", message: "Gateway connected and synced." });
    } catch (error) {
      setGatewayConnected(false);
      setGatewayStatus(error instanceof Error ? error.message : "Gateway connection failed");
      setDashboardNotice({ type: "error", message: error instanceof Error ? error.message : "Gateway connection failed" });
    } finally {
      setGatewayLoading(false);
    }
  };

  const loadGatewayAgents = async () => {
    if (!gatewayUrl.trim()) return;
    try {
      const result = await gatewayApi<{ agents: unknown[]; source?: string; warning?: string }>("/api/openclaw/gateway/agents", {
        url: gatewayUrl.trim(),
        token: gatewayToken.trim() || undefined,
        password: gatewayPassword.trim() || undefined,
        action: "list",
      });
      const mapped = (result.agents ?? []).map((entry) => {
          const row = entry as Record<string, unknown>;
          return {
            id:
              typeof row.id === "string"
                ? row.id
                : typeof row.deviceId === "string"
                  ? row.deviceId
                  : typeof row.nodeId === "string"
                    ? row.nodeId
                    : undefined,
            name:
              typeof row.name === "string"
                ? row.name
                : typeof row.label === "string"
                  ? row.label
                  : typeof row.title === "string"
                    ? row.title
                    : undefined,
            workspace: typeof row.workspace === "string" ? row.workspace : undefined,
            default: Boolean(row.default),
            state:
              row.state === "running" || row.state === "down" || row.state === "ready"
                ? (row.state as "ready" | "running" | "down")
                : undefined,
            info: typeof row.info === "string" ? row.info : undefined,
            logs: Array.isArray(row.logs) ? row.logs.map((item) => String(item)) : undefined,
          };
        });
      if (mapped.length > 0) {
        setGatewayAgents(mapped);
        setAgents(
          mapped.map((agent) => ({
            name: agent.name || agent.id || "gateway-agent",
            state: agent.state ?? "ready",
            info: agent.info ?? (agent.workspace ? `Workspace: ${agent.workspace}` : "Connected via gateway"),
            logs: agent.logs ?? [],
          }))
        );
        setSelectedAgentName(mapped[0].name || mapped[0].id || "gateway-agent");
      } else if (gatewayNodes.length > 0) {
        setGatewayAgents(
          gatewayNodes.map((node, idx) => ({
            id: `node-${idx + 1}`,
            name: node.name,
            workspace: undefined,
            default: false,
          }))
        );
      } else {
        setGatewayAgents([]);
      }
      if (result.warning) {
        setDashboardNotice({ type: "success", message: result.warning });
      }
    } catch (error) {
      setDashboardNotice({ type: "error", message: error instanceof Error ? error.message : "Loading agents failed" });
    }
  };

  const createGatewayAgent = async () => {
    if (!gatewayUrl.trim()) {
      setDashboardNotice({ type: "error", message: "Set gateway URL before creating agents." });
      return;
    }
    if (!gatewayAgentId.trim() || !gatewayAgentName.trim()) {
      setDashboardNotice({ type: "error", message: "Agent id and agent name are required." });
      return;
    }
    try {
      await gatewayApi<{ ok: boolean }>("/api/openclaw/gateway/agents", {
        url: gatewayUrl.trim(),
        token: gatewayToken.trim() || undefined,
        password: gatewayPassword.trim() || undefined,
        action: "create",
        agent: {
          id: gatewayAgentId.trim(),
          name: gatewayAgentName.trim(),
          workspace: gatewayAgentWorkspace.trim() || undefined,
          default: false,
        },
      });
      setGatewayAgentId("");
      setGatewayAgentName("");
      setGatewayAgentWorkspace("");
      await loadGatewayAgents();
      setDashboardNotice({ type: "success", message: "Gateway agent created." });
    } catch (error) {
      setDashboardNotice({ type: "error", message: error instanceof Error ? error.message : "Agent creation failed" });
    }
  };

  const readGatewayDoc = async () => {
    if (!gatewayUrl.trim() || !gatewayDocPath.trim()) {
      setDashboardNotice({ type: "error", message: "Set gateway URL and document path first." });
      return;
    }
    try {
      const result = await gatewayApi<{ payload: unknown }>("/api/openclaw/gateway/docs", {
        url: gatewayUrl.trim(),
        token: gatewayToken.trim() || undefined,
        password: gatewayPassword.trim() || undefined,
        action: "read",
        path: gatewayDocPath.trim(),
        readMethod: gatewayDocReadMethod.trim() || "workspace.read",
      });
      const payload = result.payload as Record<string, unknown>;
      const content =
        typeof payload?.content === "string"
          ? payload.content
          : typeof payload?.text === "string"
            ? payload.text
            : JSON.stringify(result.payload, null, 2);
      setGatewayDocContent(content);
      setDashboardNotice({ type: "success", message: `Loaded ${gatewayDocPath.trim()}.` });
    } catch (error) {
      setDashboardNotice({ type: "error", message: error instanceof Error ? error.message : "Document read failed" });
    }
  };

  const saveGatewayDoc = async () => {
    if (!gatewayUrl.trim() || !gatewayDocPath.trim()) {
      setDashboardNotice({ type: "error", message: "Set gateway URL and document path first." });
      return;
    }
    try {
      await gatewayApi<{ payload: unknown }>("/api/openclaw/gateway/docs", {
        url: gatewayUrl.trim(),
        token: gatewayToken.trim() || undefined,
        password: gatewayPassword.trim() || undefined,
        action: "write",
        path: gatewayDocPath.trim(),
        content: gatewayDocContent,
        writeMethod: gatewayDocWriteMethod.trim() || "workspace.write",
      });
      setDashboardNotice({ type: "success", message: `Saved ${gatewayDocPath.trim()}.` });
    } catch (error) {
      setDashboardNotice({ type: "error", message: error instanceof Error ? error.message : "Document save failed" });
    }
  };

  useEffect(() => {
    if (!userId || !gatewayUrl.trim()) return;
    void syncGatewayBootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, gatewayUrl]);

  const signIn = async () => {
    if (!email || !password) return;
    setAuthLoading(true);
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setAuthError(error.message);
    setAuthLoading(false);
  };

  const signUp = async () => {
    if (!email || !password) return;
    if (password !== confirmPassword) {
      setAuthError("Passwords do not match.");
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) {
      setAuthError(error.message);
    } else {
      setAuthError("Signup successful. Please confirm your email if confirmation is enabled.");
    }
    setAuthLoading(false);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUserId(null);
    setTasks([]);
    setIssues([]);
    setProjects([]);
    setTags([]);
    setAgents([]);
    setCalendarEvents([]);
    setHydrated(false);
  };

  if (!authReady) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Loading</CardTitle>
            <CardDescription>Checking your authentication session...</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Supabase Not Configured</CardTitle>
            <CardDescription>Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local`.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_50%_0%,#1e293b_0,#0f172a_35%,#020617_100%)]">
        <div className="pointer-events-none absolute left-[-8rem] top-[-4rem] h-72 w-72 rounded-full bg-sky-500/20 blur-3xl transition-all duration-700 hover:bg-sky-500/30" />
        <div className="pointer-events-none absolute right-[-5rem] top-24 h-64 w-64 rounded-full bg-cyan-400/15 blur-3xl transition-all duration-700 hover:bg-cyan-300/25" />

        <div className="absolute left-6 top-6 z-10 flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 backdrop-blur">
          <ShieldCheck className="h-4 w-4 text-cyan-300" />
          <span className="text-sm font-semibold tracking-wide text-white">AgenticOS</span>
        </div>

        <div className="absolute right-6 top-6 z-10">
          <Button variant="outline" size="icon" onClick={toggleTheme} aria-label="Toggle dark mode" className="border-white/25 bg-white/5 text-white hover:bg-white/10">
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>

        <div className="relative mx-auto w-[95vw] max-w-6xl px-4 pb-12 pt-24">
          <div className="mx-auto max-w-4xl space-y-5 text-center">
            <Badge className="border border-cyan-300/40 bg-cyan-400/20 text-cyan-100">AgenticOS</Badge>
            <h1 className="text-4xl font-semibold tracking-tight text-white md:text-6xl">
              Operate Agent Workflows With
              <span
                className="block bg-gradient-to-r from-cyan-300 via-emerald-300 to-sky-400 bg-[length:220%_100%] bg-clip-text text-transparent"
                style={{ animation: "agenticShine 3.5s linear infinite" }}
              >
                Precision and Momentum
              </span>
            </h1>
            <p className="mx-auto max-w-3xl text-base text-slate-300 md:text-lg">
              Unified planning, execution, and observability across projects, issues, tasks, and calendar workflows.
              Built for teams that need fast decisions, clear ownership, and reliable delivery.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <Button
                onClick={() => {
                  setAuthError(null);
                  setAuthModalOpen(true);
                }}
                className="min-w-36 rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 px-7 py-5 text-slate-950 shadow-[0_10px_30px_rgba(16,185,129,0.25)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(6,182,212,0.35)] active:scale-[0.98]"
              >
                Get started
              </Button>
            </div>
          </div>

          <div className="relative mx-auto mt-10 w-full max-w-5xl">
            <div className="grid gap-3 md:grid-cols-2">
              {marketingCards.map((item, idx) => {
                const Icon = item.icon;
                return (
                  <Card
                    key={item.title}
                    className="border-white/15 bg-slate-950/70 transition duration-200 hover:-translate-y-0.5 hover:bg-slate-900/75"
                    style={{
                      transform: authCardsVisible ? "translateY(0px)" : "translateY(22px)",
                      opacity: authCardsVisible ? 1 : 0,
                      transition: `all 500ms ease ${idx * 120}ms`,
                    }}
                  >
                    <CardContent className="space-y-2 p-4">
                      <div className="flex items-center gap-2">
                        <div className="rounded-md border border-cyan-300/30 bg-cyan-400/20 p-1.5">
                          <Icon className="h-4 w-4 text-cyan-200" />
                        </div>
                        <p className="text-sm font-semibold text-white">{item.title}</p>
                      </div>
                      <p className="text-sm text-slate-300">{item.text}</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            <Dialog open={authModalOpen} onOpenChange={setAuthModalOpen}>
              <DialogContent className="h-[530px] w-full max-w-[500px] border-white/20 bg-slate-950/95 p-0 shadow-2xl">
                <div className="flex h-full flex-col">
                  <DialogHeader className="px-6 pb-0 pt-6">
                    <DialogTitle className="text-white">Access AgenticOS</DialogTitle>
                    <DialogDescription className="text-slate-300">
                      Sign in or create your workspace to continue to the command center.
                    </DialogDescription>
                  </DialogHeader>
                  <Tabs
                    value={authMode}
                    onValueChange={(value) => {
                      setAuthMode(value as "signin" | "signup");
                      setAuthError(null);
                    }}
                    className="flex flex-1 flex-col px-6 pb-6 pt-4"
                  >
                    <TabsList className="grid h-11 w-full grid-cols-2 rounded-xl bg-slate-900/80 p-1">
                      <TabsTrigger value="signin" className="rounded-lg">
                        Sign In
                      </TabsTrigger>
                      <TabsTrigger value="signup" className="rounded-lg">
                        Sign Up
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="signin" className="mt-4 flex flex-1 flex-col data-[state=inactive]:hidden">
                      <div className="space-y-3">
                        <Input
                          type="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          placeholder="Email"
                          className="h-10 border-white/20 bg-white/5 text-white placeholder:text-slate-400"
                        />
                        <Input
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder="Password"
                          className="h-10 border-white/20 bg-white/5 text-white placeholder:text-slate-400"
                        />
                      </div>
                      <div className="mt-auto space-y-3">
                        {authError && <p className="text-xs text-rose-400">{authError}</p>}
                        <Button
                          disabled={authLoading}
                          onClick={signIn}
                          className="h-10 w-full rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400"
                        >
                          Sign In
                        </Button>
                      </div>
                    </TabsContent>

                    <TabsContent value="signup" className="mt-4 flex flex-1 flex-col data-[state=inactive]:hidden">
                      <div className="space-y-3">
                        <Input
                          type="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          placeholder="Email"
                          className="h-10 border-white/20 bg-white/5 text-white placeholder:text-slate-400"
                        />
                        <Input
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder="Password"
                          className="h-10 border-white/20 bg-white/5 text-white placeholder:text-slate-400"
                        />
                        <Input
                          type="password"
                          value={confirmPassword}
                          onChange={(event) => setConfirmPassword(event.target.value)}
                          placeholder="Confirm Password"
                          className="h-10 border-white/20 bg-white/5 text-white placeholder:text-slate-400"
                        />
                      </div>
                      <div className="mt-auto space-y-3">
                        {authError && <p className="text-xs text-rose-400">{authError}</p>}
                        <Button
                          disabled={authLoading}
                          onClick={signUp}
                          className="h-10 w-full rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400"
                        >
                          Create Account
                        </Button>
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <style jsx>{`
          @keyframes agenticShine {
            0% {
              background-position: 0% 50%;
            }
            100% {
              background-position: 100% 50%;
            }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[radial-gradient(circle_at_20%_20%,#f8fafc_0,#eff6ff_45%,#eef2ff_100%)] dark:[--background:oklch(0.145_0.015_255)] dark:[--card:oklch(0.19_0.015_253)] dark:[--popover:oklch(0.2_0.015_252)] dark:[--muted:oklch(0.24_0.012_252)] dark:[--accent:oklch(0.26_0.014_250)] dark:[--border:oklch(0.5_0.015_250_/_0.32)] dark:[--input:oklch(0.4_0.015_250_/_0.4)] dark:bg-[radial-gradient(circle_at_50%_0%,#1e293b_0,#0f172a_35%,#020617_100%)]">
      <div className="pointer-events-none absolute left-[-8rem] top-[-4rem] hidden h-72 w-72 rounded-full bg-sky-500/18 blur-3xl dark:block" />
      <div className="pointer-events-none absolute right-[-5rem] top-24 hidden h-64 w-64 rounded-full bg-cyan-400/14 blur-3xl dark:block" />
      <div className="relative z-10 mx-auto flex w-[98vw] max-w-none gap-4 p-3 md:p-5">
        <aside
          onMouseEnter={() => setIsSidebarHovered(true)}
          onMouseLeave={() => {
            setIsSidebarHovered(false);
            if (!isSidebarPinned) setIsSidebarOpenedByButton(false);
          }}
          className={cn(
            "hidden h-[calc(100vh-2.5rem)] overflow-hidden rounded-xl border bg-card shadow-sm lg:flex lg:flex-col dark:border-slate-500/35 dark:bg-slate-800/55 dark:backdrop-blur",
            isSidebarExpanded ? "w-56 p-2" : "w-14 p-1.5"
          )}
        >
          <div className={cn("mb-1 flex", isSidebarExpanded ? "justify-between" : "justify-center")}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsSidebarOpenedByButton((prev) => !prev)}
              aria-label={isSidebarExpanded ? "Collapse sidebar" : "Open sidebar"}
            >
              {isSidebarExpanded ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
            {isSidebarExpanded && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  setIsSidebarPinned((value) => {
                    const next = !value;
                    if (!next && !isSidebarHovered) setIsSidebarOpenedByButton(false);
                    return next;
                  })
                }
                aria-label={isSidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
              >
                {isSidebarPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </Button>
            )}
          </div>
          <SidebarContent
            active={activeTab}
            setActive={setActiveTab}
            collapsed={!isSidebarExpanded}
          />
        </aside>

        <main className="flex-1 space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card/90 p-3 shadow-sm backdrop-blur md:p-4 dark:border-slate-500/35 dark:bg-slate-800/55 dark:shadow-[0_8px_30px_rgba(15,23,42,0.35)]">
            <Sheet>
              <SheetTrigger className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background lg:hidden">
                <Menu className="h-4 w-4" />
              </SheetTrigger>
              <SheetContent side="left" className="w-[82vw] sm:w-[320px]">
                <SidebarContent
                  active={activeTab}
                  setActive={setActiveTab}
                  collapsed={false}
                />
              </SheetContent>
            </Sheet>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">AgenticOS</h1>
                <div
                  className="relative"
                  onMouseEnter={() => setHealthHoverOpen(true)}
                  onMouseLeave={() => setHealthHoverOpen(false)}
                >
                  <span
                    className={cn(
                      "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
                      combinedHealth === "healthy"
                        ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.7)]"
                        : combinedHealth === "down"
                          ? "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.7)]"
                        : "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.7)]"
                    )}
                  />
                  {healthHoverOpen && (
                    <div className="absolute left-0 top-5 z-50 w-56 rounded-lg border bg-popover p-2 text-xs shadow-xl">
                      <p
                        className={cn(
                          "font-medium",
                          combinedHealth === "healthy" ? "text-emerald-500" : "text-amber-500"
                        )}
                      >
                        Service Health
                      </p>
                      <p className="mt-1">
                        <span className="text-muted-foreground">Database: </span>
                        <span className={dbConnected ? "text-emerald-500" : "text-amber-500"}>
                          {dbConnected ? "connected" : "warning"}
                        </span>
                      </p>
                      <p>
                        <span className="text-muted-foreground">Openclaw: </span>
                        <span className={openclawConnected ? "text-emerald-500" : "text-amber-500"}>
                          {openclawConnected ? "connected" : "warning"}
                        </span>
                      </p>
                    </div>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground">Agent operations workspace with planning, execution, and observability.</p>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Input className="hidden w-56 md:block" placeholder="Search tasks, issues, sessions..." />
              <div ref={avatarMenuRef} className="relative">
                <button
                  type="button"
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
                  onClick={() => setAvatarMenuOpen((prev) => !prev)}
                  aria-label="Open account menu"
                >
                  <Avatar className="h-8 w-8 cursor-pointer ring-1 ring-border/60 transition hover:ring-sky-400/60">
                    <AvatarFallback className="bg-sky-700 text-sky-100">
                      {(userEmail?.slice(0, 2) || "AL").toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </button>
                {avatarMenuOpen && (
                  <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border bg-popover p-1 shadow-xl">
                    <div className="truncate px-2 py-1.5 text-xs text-muted-foreground">{userEmail || "Authenticated"}</div>
                    <button
                      type="button"
                      onClick={() => {
                        toggleTheme();
                        setAvatarMenuOpen(false);
                      }}
                      className="flex w-full items-center rounded-md px-2 py-2 text-left text-sm transition hover:bg-muted"
                    >
                      {darkMode ? "Switch To Light Mode" : "Switch To Dark Mode"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAvatarMenuOpen(false);
                        setLogoutConfirmOpen(true);
                      }}
                      className="flex w-full items-center rounded-md px-2 py-2 text-left text-sm text-rose-500 transition hover:bg-rose-500/10"
                    >
                      Sign Out
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <Dialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Sign out?</DialogTitle>
                <DialogDescription>You will be redirected to the landing page and need to sign in again.</DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:justify-end">
                <Button variant="outline" onClick={() => setLogoutConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setLogoutConfirmOpen(false);
                    void signOut();
                  }}
                >
                  Logout
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={projectDeleteDialogOpen}
            onOpenChange={(open) => {
              setProjectDeleteDialogOpen(open);
              if (!open) setProjectDeleteTarget(null);
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Delete Project?</DialogTitle>
                <DialogDescription>
                  {projectDeleteTarget
                    ? `This will delete project ${projectDeleteTarget.title} (${projectDeleteTarget.code}) and ${deleteImpactIssueCount} related issue(s).`
                    : "This action deletes the project and related issues."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:justify-end">
                <Button variant="outline" onClick={() => setProjectDeleteDialogOpen(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => void confirmDeleteProject()}>
                  Delete Project
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-[min(92vw,420px)] flex-col gap-2">
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={cn(
                  "pointer-events-auto rounded-lg border px-3 py-2 shadow-lg backdrop-blur",
                  toast.type === "error"
                    ? "border-rose-400/40 bg-rose-950/85 text-rose-100"
                    : "border-emerald-400/35 bg-emerald-950/80 text-emerald-100"
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm">{toast.message}</p>
                  <div className="flex items-center gap-1.5">
                    {toast.actionLabel && toast.onAction && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7"
                        onClick={() => {
                          toast.onAction?.();
                          setToasts((prev) => prev.filter((item) => item.id !== toast.id));
                        }}
                      >
                        {toast.actionLabel}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-current hover:bg-white/10"
                      onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
                    >
                      x
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {boardStats.map((item) => (
              <Card key={item.label}>
                <CardHeader className="pb-2">
                  <CardDescription>{item.label}</CardDescription>
                  <CardTitle className="text-2xl">{item.value}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                </CardContent>
              </Card>
            ))}
          </section>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="mb-2 h-auto flex-wrap justify-start gap-2 bg-transparent p-0">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="kanban">Kanban</TabsTrigger>
              <TabsTrigger value="tasks">Tasks</TabsTrigger>
              <TabsTrigger value="projects">Projects</TabsTrigger>
              <TabsTrigger value="issues">Issues</TabsTrigger>
              <TabsTrigger value="metrics">Statistics</TabsTrigger>
              <TabsTrigger value="logs">Agent Logs</TabsTrigger>
              <TabsTrigger value="calendar">Calendar</TabsTrigger>
              <TabsTrigger value="gateway">Gateway</TabsTrigger>
            </TabsList>

            <Dialog open={issueDialogOpen} onOpenChange={setIssueDialogOpen}>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{editingIssueKey ? "Edit Issue" : "Create Issue"}</DialogTitle>
                  <DialogDescription>
                    {editingIssueKey ? "Update issue details and save changes" : "Jira-style issue creation with project, ownership, and planning fields"}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label htmlFor="issue-title" className="text-xs font-medium">
                      Title
                    </label>
                    <Input
                      id="issue-title"
                      value={newIssue.title}
                      onChange={(event) => setNewIssue((prev) => ({ ...prev, title: event.target.value }))}
                      placeholder="Issue title"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="issue-description" className="text-xs font-medium">
                      Description
                    </label>
                    <Textarea
                      id="issue-description"
                      value={newIssue.description}
                      onChange={(event) => setNewIssue((prev) => ({ ...prev, description: event.target.value }))}
                      placeholder="Issue description"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-1">
                      <label htmlFor="issue-project" className="text-xs font-medium">
                        Project
                      </label>
                      <select
                        id="issue-project"
                        value={newIssue.projectCode}
                        onChange={(event) => setNewIssue((prev) => ({ ...prev, projectCode: event.target.value }))}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        {projectOptions.map((project) => (
                          <option key={project.code} value={project.code}>
                            {project.title} ({project.code})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="issue-owner" className="text-xs font-medium">
                        Owner
                      </label>
                      <select
                        id="issue-owner"
                        value={newIssue.owner || agentNames[0] || ""}
                        onChange={(event) => setNewIssue((prev) => ({ ...prev, owner: event.target.value }))}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        {agentNames.map((agent) => (
                          <option key={agent}>{agent}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="issue-reporter" className="text-xs font-medium">
                        Reporter
                      </label>
                      <select
                        id="issue-reporter"
                        value={newIssue.reporter || agentNames[0] || ""}
                        onChange={(event) => setNewIssue((prev) => ({ ...prev, reporter: event.target.value }))}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        {agentNames.map((agent) => (
                          <option key={agent}>{agent}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="issue-type" className="text-xs font-medium">
                        Issue Type
                      </label>
                      <select
                        id="issue-type"
                        value={newIssue.issueType}
                        onChange={(event) => setNewIssue((prev) => ({ ...prev, issueType: event.target.value as IssueType }))}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        {ISSUE_TYPES.map((type) => (
                          <option key={type}>{type}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="issue-priority" className="text-xs font-medium">
                        Priority
                      </label>
                      <select
                        id="issue-priority"
                        value={newIssue.priority}
                        onChange={(event) => setNewIssue((prev) => ({ ...prev, priority: event.target.value as Priority }))}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        {PRIORITIES.map((priority) => (
                          <option key={priority}>{priority}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="issue-story-points" className="text-xs font-medium">
                        Story Points
                      </label>
                      <Input
                        id="issue-story-points"
                        type="number"
                        min={0}
                        value={newIssue.storyPoints}
                        onChange={(event) => setNewIssue((prev) => ({ ...prev, storyPoints: Number(event.target.value || 0) }))}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="issue-criteria" className="text-xs font-medium">
                      Acceptance Criteria
                    </label>
                    <Textarea
                      id="issue-criteria"
                      value={newIssue.acceptanceCriteria}
                      onChange={(event) => setNewIssue((prev) => ({ ...prev, acceptanceCriteria: event.target.value }))}
                      placeholder="Define expected outcome"
                    />
                  </div>
                  <TagSelector
                    availableTags={tags}
                    selectedTagIds={newIssue.tagIds}
                    onChange={(tagIds) => setNewIssue((prev) => ({ ...prev, tagIds }))}
                    onCreateTag={createTag}
                  />
                </div>
                <DialogFooter>
                  <Button onClick={editingIssueKey ? handleSaveIssue : handleCreateIssue}>
                    {editingIssueKey ? "Save Issue" : "Create Issue"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <TabsContent value="overview" className="mt-0">
              <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
                <Card>
                  <CardHeader>
                    <CardTitle>Agents</CardTitle>
                    <CardDescription>Click an agent to inspect logs and current runtime status</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {agents.map((agent) => (
                      <button
                        key={agent.name}
                        type="button"
                        onClick={() => setSelectedAgentName(agent.name)}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg border p-2.5 text-left text-sm transition",
                          selectedAgentName === agent.name ? "bg-primary/10 ring-1 ring-primary/50" : "hover:bg-muted/30"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <StatusLed state={agent.state} />
                          <span>{agent.name}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{agent.info}</span>
                      </button>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>{selectedAgent?.name ?? "Agent Logs"}</CardTitle>
                    <CardDescription>Latest runtime logs for selected agent</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-64 rounded-lg border bg-zinc-950 p-3 text-xs text-zinc-200">
                      <div className="space-y-2 font-mono">
                        {(selectedAgent?.logs ?? []).map((line, idx) => (
                          <p key={`${selectedAgent?.name}-${idx}`}>{line}</p>
                        ))}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="kanban" className="mt-0">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardTitle>Kanban Board</CardTitle>
                      <CardDescription>Cross-lane drag and drop with responsive full-width lanes</CardDescription>
                    </div>
                    <Button
                      type="button"
                      className="inline-flex items-center gap-2"
                      onClick={() => {
                        setEditingIssueKey(null);
                        setNewIssue((prev) => ({
                          ...prev,
                          title: "",
                          description: "",
                          issueType: "Bug",
                          priority: "Medium",
                          storyPoints: 0,
                          acceptanceCriteria: "",
                          resolvedAt: null,
                          tagIds: [],
                          projectCode: projectOptions[0]?.code ?? prev.projectCode,
                        }));
                        setIssueDialogOpen(true);
                      }}
                    >
                      <Plus className="h-4 w-4" />
                      New Issue
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCorners}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragEnd={handleDragEnd}
                  >
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {kanbanColumns.map((column) => (
                        <KanbanColumnView
                          key={column.id}
                          column={column}
                          onOpenIssue={(issueKey) => {
                            setSelectedIssueKey(issueKey);
                            setIssueDetailsOpen(true);
                          }}
                        />
                      ))}
                    </div>
                    <DragOverlay>
                      {activeDragCard ? (
                        <SortableCardItem card={activeDragCard} borderClass={getKanbanBorderClass(activeDragColumnId)} />
                      ) : null}
                    </DragOverlay>
                  </DndContext>

                  <Dialog open={issueDetailsOpen} onOpenChange={setIssueDetailsOpen}>
                    <DialogContent className="sm:max-w-xl">
                      <DialogHeader>
                        <DialogTitle>{selectedIssue?.key ?? "Issue Details"}</DialogTitle>
                        <DialogDescription>{selectedIssue?.title ?? "No issue selected"}</DialogDescription>
                      </DialogHeader>
                      {selectedIssue && (
                        <div className="space-y-3 text-sm">
                          <p>{selectedIssue.description}</p>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">
                              {selectedIssue.projectName} ({selectedIssue.projectCode})
                            </Badge>
                            <Badge className="bg-sky-100 text-sky-800 hover:bg-sky-100">{selectedIssue.issueType}</Badge>
                            <Badge variant="secondary">{selectedIssue.owner}</Badge>
                            <Badge variant="outline">{selectedIssue.priority}</Badge>
                            <Badge variant="outline">{issueStateLabelFromLane(selectedIssue.lane)}</Badge>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div className="rounded-md border p-2">
                              <p className="text-xs text-muted-foreground">Reporter</p>
                              <p>{selectedIssue.reporter}</p>
                            </div>
                            <div className="rounded-md border p-2">
                              <p className="text-xs text-muted-foreground">Story Points</p>
                              <p>{selectedIssue.storyPoints}</p>
                            </div>
                          </div>
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">Tags</p>
                            <div className="flex flex-wrap gap-2">
                              {selectedIssue.tagIds.map((tagId) => {
                                const tag = tagById.get(tagId);
                                if (!tag) return null;
                                return (
                                  <Badge key={tag.id} className="text-white" style={{ backgroundColor: tag.color }}>
                                    {tag.label}
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                          <div className="space-y-1 rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Acceptance Criteria</p>
                            <p>{selectedIssue.acceptanceCriteria || "Not set"}</p>
                          </div>
                        </div>
                      )}
                    </DialogContent>
                  </Dialog>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="tasks" className="mt-0">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">Tasks</h3>
                    <p className="text-sm text-muted-foreground">Compact clickable list with agent, tags, and status lamps</p>
                  </div>
                  <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
                    <DialogTrigger
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                      onClick={() => {
                        setEditingTaskId(null);
                        setNewTask((prev) => ({
                          ...prev,
                          title: "",
                          description: "",
                          priority: "Medium",
                          status: "Todo",
                          resolvedAt: null,
                          tagIds: [],
                          project: projectOptions[0]?.title ?? prev.project,
                        }));
                      }}
                    >
                      <Plus className="h-4 w-4" />
                      New Task
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-xl">
                      <DialogHeader>
                        <DialogTitle>{editingTaskId ? "Edit Task" : "Create Task"}</DialogTitle>
                        <DialogDescription>
                          {editingTaskId ? "Update task details and save changes" : "Add title, description, and agent assignment"}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label htmlFor="task-title" className="text-xs font-medium">
                            Title
                          </label>
                          <Input
                            id="task-title"
                            value={newTask.title}
                            onChange={(event) => setNewTask((prev) => ({ ...prev, title: event.target.value }))}
                            placeholder="Task title"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="task-description" className="text-xs font-medium">
                            Description
                          </label>
                          <Textarea
                            id="task-description"
                            value={newTask.description}
                            onChange={(event) => setNewTask((prev) => ({ ...prev, description: event.target.value }))}
                            placeholder="Task description"
                          />
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                          <div className="space-y-1">
                            <label htmlFor="task-project" className="text-xs font-medium">
                              Project
                            </label>
                            <select
                              id="task-project"
                              value={newTask.project}
                              onChange={(event) => setNewTask((prev) => ({ ...prev, project: event.target.value }))}
                              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            >
                              {projectOptions.map((project) => (
                                <option key={project.code} value={project.title}>
                                  {project.title} ({project.code})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="task-agent" className="text-xs font-medium">
                              Agent
                            </label>
                            <select
                              id="task-agent"
                              value={newTask.agent || agentNames[0] || ""}
                              onChange={(event) => setNewTask((prev) => ({ ...prev, agent: event.target.value }))}
                              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            >
                              {agentNames.map((agent) => (
                                <option key={agent}>{agent}</option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="task-priority" className="text-xs font-medium">
                              Priority
                            </label>
                            <select
                              id="task-priority"
                              value={newTask.priority}
                              onChange={(event) =>
                                setNewTask((prev) => ({ ...prev, priority: event.target.value as Task["priority"] }))
                              }
                              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            >
                              <option>High</option>
                              <option>Medium</option>
                              <option>Low</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="task-status" className="text-xs font-medium">
                              Status
                            </label>
                            <select
                              id="task-status"
                              value={newTask.status}
                              onChange={(event) =>
                                setNewTask((prev) => ({ ...prev, status: event.target.value as Task["status"] }))
                              }
                              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            >
                              <option>Todo</option>
                              <option>In Progress</option>
                              <option>Done</option>
                            </select>
                          </div>
                        </div>
                        <TagSelector
                          availableTags={tags}
                          selectedTagIds={newTask.tagIds}
                          onChange={(tagIds) => setNewTask((prev) => ({ ...prev, tagIds }))}
                          onCreateTag={createTag}
                        />
                      </div>
                      <DialogFooter>
                        <Button onClick={editingTaskId ? handleSaveTask : handleCreateTask}>
                          {editingTaskId ? "Save Task" : "Create Task"}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>

                <div className="space-y-2">
                  <details className="group border-b">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm font-semibold">
                      <span>Not Started ({todoTasks.length})</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                    </summary>
                    <div className="space-y-2 border-t p-3">
                      {todoTasks.length === 0 && <p className="text-xs text-muted-foreground">No not-started tasks.</p>}
                      {todoTasks.map((task) => renderTaskCard(task))}
                    </div>
                  </details>

                  <details className="group border-b">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm font-semibold">
                      <span>In Progress ({inProgressTasks.length})</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                    </summary>
                    <div className="space-y-2 border-t p-3">
                      {inProgressTasks.length === 0 && <p className="text-xs text-muted-foreground">No in-progress tasks.</p>}
                      {inProgressTasks.map((task) => renderTaskCard(task))}
                    </div>
                  </details>

                  <details className="group border-b">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm font-semibold">
                      <span>Resolved ({resolvedTasks.length})</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                    </summary>
                    <div className="space-y-3 border-t p-3">
                      {resolvedTaskGroups.length === 0 && <p className="text-xs text-muted-foreground">No resolved tasks yet.</p>}
                      {resolvedTaskGroups.map(([day, group]) => (
                        <div key={day} className="space-y-2">
                          <p className="text-xs font-semibold text-muted-foreground">{format(new Date(day), "EEE, dd MMM yyyy")}</p>
                          {group.map((task) => renderTaskCard(task))}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="projects" className="mt-0">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">Projects</h3>
                    <p className="text-sm text-muted-foreground">Project docs, instructions, and manager assignment</p>
                  </div>
                  <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
                    <DialogTrigger className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
                      <Plus className="h-4 w-4" />
                      New Project
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-xl">
                      <DialogHeader>
                        <DialogTitle>Create Project</DialogTitle>
                        <DialogDescription>Add title, docs, instruction, and manager agent</DialogDescription>
                      </DialogHeader>
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label htmlFor="project-code" className="text-xs font-medium">
                            Project Code
                          </label>
                          <Input
                            id="project-code"
                            value={newProject.code}
                            onChange={(event) => setNewProject((prev) => ({ ...prev, code: event.target.value }))}
                            placeholder="Project code (e.g. PM, OC)"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="project-title" className="text-xs font-medium">
                            Title
                          </label>
                          <Input
                            id="project-title"
                            value={newProject.title}
                            onChange={(event) => setNewProject((prev) => ({ ...prev, title: event.target.value }))}
                            placeholder="Project title"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="project-description" className="text-xs font-medium">
                            Description
                          </label>
                          <Textarea
                            id="project-description"
                            value={newProject.description}
                            onChange={(event) => setNewProject((prev) => ({ ...prev, description: event.target.value }))}
                            placeholder="Description"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="project-docs" className="text-xs font-medium">
                            Reference Docs
                          </label>
                          <Textarea
                            id="project-docs"
                            value={newProject.docs}
                            onChange={(event) => setNewProject((prev) => ({ ...prev, docs: event.target.value }))}
                            placeholder={"Document A\nDocument B"}
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="project-instruction" className="text-xs font-medium">
                            Instruction
                          </label>
                          <Textarea
                            id="project-instruction"
                            value={newProject.instruction}
                            onChange={(event) => setNewProject((prev) => ({ ...prev, instruction: event.target.value }))}
                            placeholder="How agents should work in this project"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="project-manager" className="text-xs font-medium">
                            Manager Agent
                          </label>
                          <select
                            id="project-manager"
                            value={newProject.manager || agentNames[0] || ""}
                            onChange={(event) => setNewProject((prev) => ({ ...prev, manager: event.target.value }))}
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          >
                            {agentNames.map((agent) => (
                              <option key={agent}>{agent}</option>
                            ))}
                          </select>
                        </div>
                        <TagSelector
                          availableTags={tags}
                          selectedTagIds={newProject.tagIds}
                          onChange={(tagIds) => setNewProject((prev) => ({ ...prev, tagIds }))}
                          onCreateTag={createTag}
                        />
                      </div>
                      <DialogFooter>
                        <Button onClick={handleCreateProject}>Create Project</Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  {projects.map((project) => (
                    <Card key={project.id}>
                      <CardHeader>
                        <CardTitle>
                          {project.title} <span className="text-muted-foreground">({project.code})</span>
                        </CardTitle>
                        <CardDescription>{project.description}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-muted-foreground">Project Manager Agent</p>
                          <select
                            value={project.manager}
                            onChange={(event) =>
                              setProjects((prev) => {
                                const previousManager = project.manager;
                                const next = prev.map((entry) =>
                                  entry.id === project.id ? { ...entry, manager: event.target.value } : entry
                                );
                                void (async () => {
                                  const { error } = await supabase
                                    .from("projects")
                                    .update({ manager: event.target.value })
                                    .eq("id", project.id);
                                  if (error) {
                                    setProjects((rollbackPrev) =>
                                      rollbackPrev.map((entry) =>
                                        entry.id === project.id ? { ...entry, manager: previousManager } : entry
                                      )
                                    );
                                    setDashboardNotice({
                                      type: "error",
                                      message: `Project manager update failed: ${error.message}`,
                                    });
                                  }
                                })();
                                return next;
                              })
                            }
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          >
                            {agentNames.map((agent) => (
                              <option key={agent}>{agent}</option>
                            ))}
                          </select>
                        </div>
                        <Separator />
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-muted-foreground">Documents</p>
                          <div className="flex flex-wrap gap-2">
                            {project.docs.map((doc) => (
                              <Badge key={doc} className="bg-sky-100 text-sky-800 hover:bg-sky-100">
                                {doc}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-muted-foreground">Working Instruction</p>
                          <p className="text-sm">{project.instruction}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-muted-foreground">Tags</p>
                          <div className="flex flex-wrap gap-2">
                            {project.tagIds.map((tagId) => {
                              const tag = tagById.get(tagId);
                              if (!tag) return null;
                              return (
                                <Badge key={tag.id} className="text-white" style={{ backgroundColor: tag.color }}>
                                  {tag.label}
                                </Badge>
                              );
                            })}
                          </div>
                        </div>
                        <div className="flex justify-end">
                          <Button size="sm" variant="destructive" onClick={() => requestDeleteProject(project)}>
                            Delete Project
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="issues" className="mt-0">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">Issues</h3>
                    <p className="text-sm text-muted-foreground">Create issues and push them automatically into Kanban Backlog</p>
                  </div>
                  <Button
                    type="button"
                    className="inline-flex items-center gap-2"
                    onClick={() => {
                      setEditingIssueKey(null);
                      setNewIssue((prev) => ({
                        ...prev,
                        title: "",
                        description: "",
                        issueType: "Bug",
                        priority: "Medium",
                        storyPoints: 0,
                        acceptanceCriteria: "",
                        resolvedAt: null,
                        tagIds: [],
                        projectCode: projectOptions[0]?.code ?? prev.projectCode,
                      }));
                      setIssueDialogOpen(true);
                    }}
                  >
                    <Plus className="h-4 w-4" />
                    New Issue
                  </Button>
                </div>

                <div className="space-y-2">
                  <details className="group border-b">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm font-semibold">
                      <span>Backlog ({backlogIssues.length})</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                    </summary>
                    <div className="space-y-2 border-t p-3">
                      {backlogIssues.length === 0 && <p className="text-xs text-muted-foreground">No backlog issues.</p>}
                      {backlogIssues.map((issue) => renderIssueCard(issue))}
                    </div>
                  </details>

                  <details className="group border-b">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm font-semibold">
                      <span>In Progress ({inProgressIssues.length})</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                    </summary>
                    <div className="space-y-2 border-t p-3">
                      {inProgressIssues.length === 0 && <p className="text-xs text-muted-foreground">No in-progress issues.</p>}
                      {inProgressIssues.map((issue) => renderIssueCard(issue))}
                    </div>
                  </details>

                  <details className="group border-b">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm font-semibold">
                      <span>Review ({reviewIssues.length})</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                    </summary>
                    <div className="space-y-2 border-t p-3">
                      {reviewIssues.length === 0 && <p className="text-xs text-muted-foreground">No review issues.</p>}
                      {reviewIssues.map((issue) => renderIssueCard(issue))}
                    </div>
                  </details>

                  <details className="group border-b">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm font-semibold">
                      <span>Done ({resolvedIssues.length})</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                    </summary>
                    <div className="space-y-3 border-t p-3">
                      {resolvedIssueGroups.length === 0 && <p className="text-xs text-muted-foreground">No resolved issues yet.</p>}
                      {resolvedIssueGroups.map(([day, group]) => (
                        <div key={day} className="space-y-2">
                          <p className="text-xs font-semibold text-muted-foreground">{format(new Date(day), "EEE, dd MMM yyyy")}</p>
                          {group.map((issue) => renderIssueCard(issue))}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="metrics" className="mt-0">
              <div className="grid gap-3 md:grid-cols-3">
                <PieChart title="Kanban Lanes" subtitle="Distribution by board stage" segments={laneSegments} />
                <PieChart title="Issue Priorities" subtitle="Current issue balance" segments={severitySegments} />
                <PieChart title="Task Status" subtitle="Task board progress" segments={taskSegments} />
              </div>
            </TabsContent>

            <TabsContent value="logs" className="mt-0">
              <Card>
                <CardHeader>
                  <CardTitle>Agent Logs</CardTitle>
                  <CardDescription>Select an agent and inspect its log stream</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {agents.map((agent) => (
                      <Button
                        key={agent.name}
                        type="button"
                        variant={selectedAgentName === agent.name ? "default" : "outline"}
                        onClick={() => setSelectedAgentName(agent.name)}
                        className="inline-flex items-center gap-2"
                      >
                        <StatusLed state={agent.state} />
                        {agent.name}
                      </Button>
                    ))}
                  </div>
                  <ScrollArea className="h-56 rounded-lg border bg-zinc-950 p-3 text-xs text-zinc-200">
                    <div className="space-y-2 font-mono">
                      {(selectedAgent?.logs ?? []).map((line, idx) => (
                        <p key={`${selectedAgent?.name}-${idx}`}>{line}</p>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="calendar" className="mt-0">
              <CalendarBoard
                cursor={calendarCursor}
                setCursor={setCalendarCursor}
                selectedDate={selectedDate}
                setSelectedDate={setSelectedDate}
                view={calendarView}
                setView={setCalendarView}
                events={calendarEvents}
              />
            </TabsContent>

            <TabsContent value="gateway" className="mt-0">
              <div className="space-y-3">
                <Card>
                  <CardHeader>
                    <CardTitle>OpenClaw Gateway</CardTitle>
                    <CardDescription>
                      Connect through backend WebSocket RPC. Pair this dashboard device on OpenClaw if prompted.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-2 md:grid-cols-3">
                      <Input
                        value={gatewayUrl}
                        onChange={(event) => setGatewayUrl(event.target.value)}
                        placeholder="wss://your-gateway.example/ws"
                      />
                      <Input
                        value={gatewayToken}
                        onChange={(event) => setGatewayToken(event.target.value)}
                        placeholder="Gateway token (preferred)"
                        type="password"
                      />
                      <Input
                        value={gatewayPassword}
                        onChange={(event) => setGatewayPassword(event.target.value)}
                        placeholder="Gateway password (optional)"
                        type="password"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button onClick={() => void syncGatewayBootstrap()} disabled={gatewayLoading}>
                        {gatewayLoading ? "Connecting..." : "Connect / Refresh"}
                      </Button>
                      <Badge variant={gatewayConnected ? "secondary" : "outline"}>{gatewayConnected ? "Connected" : "Disconnected"}</Badge>
                      <span className="text-xs text-muted-foreground">{gatewayStatus}</span>
                    </div>
                  </CardContent>
                </Card>

                <div className="grid gap-3 lg:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle>Agents</CardTitle>
                      <CardDescription>Loaded from gateway config (`config.get`).</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="grid gap-2 md:grid-cols-3">
                        <Input value={gatewayAgentId} onChange={(event) => setGatewayAgentId(event.target.value)} placeholder="Agent id" />
                        <Input value={gatewayAgentName} onChange={(event) => setGatewayAgentName(event.target.value)} placeholder="Agent name" />
                        <Input
                          value={gatewayAgentWorkspace}
                          onChange={(event) => setGatewayAgentWorkspace(event.target.value)}
                          placeholder="Workspace path (optional)"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" onClick={() => void loadGatewayAgents()}>
                          Reload Agents
                        </Button>
                        <Button onClick={() => void createGatewayAgent()}>Create Agent</Button>
                      </div>
                      <div className="space-y-1 text-sm">
                        {gatewayAgents.length === 0 && <p className="text-muted-foreground">No agents loaded yet.</p>}
                        {gatewayAgents.map((agent) => (
                          <div key={`${agent.id}-${agent.name}`} className="rounded-md border p-2">
                            <p className="font-medium">{agent.name || agent.id || "Unnamed agent"}</p>
                            <p className="text-xs text-muted-foreground">
                              {agent.id || "no-id"} {agent.workspace ? `• ${agent.workspace}` : ""}
                            </p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Sessions</CardTitle>
                      <CardDescription>Live session list from `sessions.list`.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      {gatewaySessions.length === 0 && <p className="text-muted-foreground">No sessions loaded yet.</p>}
                      {gatewaySessions.map((session, idx) => (
                        <div key={`${session.id || session.key || idx}`} className="rounded-md border p-2">
                          <p className="font-medium">{session.key || session.id || "Session"}</p>
                          <p className="text-xs text-muted-foreground">{session.state || "unknown state"}</p>
                        </div>
                      ))}
                      <Separator />
                      <p className="text-xs text-muted-foreground">Connected nodes: {gatewayNodes.length}</p>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>SOUL.md / MEMORY.md Editor</CardTitle>
                    <CardDescription>
                      Uses gateway RPC methods (defaults: `workspace.read` / `workspace.write`). Change method names if your gateway uses different ones.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="grid gap-2 md:grid-cols-3">
                      <Input value={gatewayDocPath} onChange={(event) => setGatewayDocPath(event.target.value)} placeholder="SOUL.md or MEMORY.md" />
                      <Input
                        value={gatewayDocReadMethod}
                        onChange={(event) => setGatewayDocReadMethod(event.target.value)}
                        placeholder="Read method"
                      />
                      <Input
                        value={gatewayDocWriteMethod}
                        onChange={(event) => setGatewayDocWriteMethod(event.target.value)}
                        placeholder="Write method"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => void readGatewayDoc()}>
                        Read Document
                      </Button>
                      <Button onClick={() => void saveGatewayDoc()}>Save Document</Button>
                    </div>
                    <Textarea
                      value={gatewayDocContent}
                      onChange={(event) => setGatewayDocContent(event.target.value)}
                      className="min-h-[220px] font-mono text-xs"
                      placeholder="Document content..."
                    />
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </Tabs>

          <footer className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            <span>{hydrated ? "Connected to Supabase and synced with your account data." : "Loading Supabase data..."}</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
