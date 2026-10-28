import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "./api.js";
import { repoName } from "./repo-appearance.js";
import { formatCost } from "./usage.js";
import type { Board } from "./model.js";
import type { GroupRow, Stats } from "../server/stats.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./components/ui/chart";

const ranges = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "all", label: "All time" },
];
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;
const minutes = (value: number | null) => {
  if (value === null) return "—";
  return value < 1
    ? "<1m"
    : value < 60
      ? `${Math.round(value)}m`
      : `${(value / 60).toFixed(1)}h`;
};
const hours = (value: number | null) => {
  if (value === null) return "—";
  return value < 1
    ? `${Math.round(value * 60)}m`
    : value < 48
      ? `${value.toFixed(1)}h`
      : `${(value / 24).toFixed(1)}d`;
};
const day = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const runsConfig = {
  succeeded: { label: "Succeeded", color: "var(--status-review)" },
  failed: { label: "Failed", color: "var(--status-failed)" },
  interrupted: { label: "Interrupted", color: "var(--status-interrupted)" },
} satisfies ChartConfig;
const spendConfig = {
  cost: { label: "Spend", color: "var(--status-running)" },
} satisfies ChartConfig;
const flowConfig = {
  created: { label: "Created", color: "var(--status-ready)" },
  done: { label: "Done", color: "var(--status-review)" },
} satisfies ChartConfig;
const tokenConfig = {
  tokens: { label: "Tokens", color: "var(--status-running)" },
} satisfies ChartConfig;
const agentConfig = {
  cost: { label: "Spend", color: "var(--status-running)" },
} satisfies ChartConfig;

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-0">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="pt-1">
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        {hint && (
          <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Breakdown({
  title,
  rows,
  label,
}: {
  title: string;
  rows: GroupRow[];
  label: (name: string) => string;
}) {
  return (
    <Panel
      title={title}
      description="Runs in the selected range, most expensive first."
    >
      {rows.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          No runs in this range.
        </div>
      ) : (
        <>
          <ChartContainer
            config={agentConfig}
            className="aspect-auto"
            style={{ height: 40 + rows.slice(0, 8).length * 32 }}
          >
            <BarChart
              data={rows
                .slice(0, 8)
                .map((row) => ({ ...row, name: label(row.name) }))}
              layout="vertical"
              margin={{ left: 0, right: 12 }}
            >
              <CartesianGrid horizontal={false} />
              <YAxis
                dataKey="name"
                type="category"
                tickLine={false}
                axisLine={false}
                width={110}
                tickFormatter={(value: string) =>
                  value.length > 16 ? `${value.slice(0, 15)}…` : value
                }
              />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => formatCost(value)}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    valueFormatter={(value) => formatCost(value)}
                  />
                }
              />
              <Bar dataKey="cost" fill="var(--color-cost)" radius={3} />
            </BarChart>
          </ChartContainer>
          <table className="mt-4 w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-normal">Name</th>
                <th className="py-1 text-right font-normal">Runs</th>
                <th className="py-1 text-right font-normal">Failed</th>
                <th className="py-1 text-right font-normal">Avg run</th>
                <th className="py-1 text-right font-normal">Tokens</th>
                <th className="py-1 text-right font-normal">Spend</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {rows.map((row) => (
                <tr key={row.name} className="border-t border-border">
                  <td
                    className="max-w-40 truncate py-1.5 pr-2 font-sans"
                    title={row.name}
                  >
                    {label(row.name)}
                  </td>
                  <td className="py-1.5 text-right">{row.runs}</td>
                  <td className="py-1.5 text-right">{row.failed}</td>
                  <td className="py-1.5 text-right">
                    {minutes(row.avgMinutes)}
                  </td>
                  <td className="py-1.5 text-right">
                    {compact.format(row.tokens)}
                  </td>
                  <td className="py-1.5 text-right">{formatCost(row.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

export function Statistics({ boards }: { boards: Board[] }) {
  const [range, setRange] = useState("30");
  const [repo, setRepo] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    const load = () =>
      api<Stats>(
        `/stats?days=${range}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`,
      )
        .then((next) => {
          if (current) {
            setStats(next);
            setError("");
          }
        })
        .catch((err) => {
          if (current) setError(String(err.message ?? err));
        });
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [range, repo]);

  const select =
    "h-8 rounded-md border border-border bg-transparent px-2 text-xs text-foreground";
  const summary = stats?.summary;
  const tokenRows = stats
    ? [
        { kind: "Input", tokens: stats.tokens.input },
        { kind: "Output", tokens: stats.tokens.output },
        { kind: "Cache read", tokens: stats.tokens.cacheRead },
        { kind: "Cache write", tokens: stats.tokens.cacheWrite },
      ]
    : [];
  const tick = (value: string) => day(value);
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-6 lg:px-10">
        <div>
          <h1 className="text-[27px] font-semibold tracking-[-.05em]">
            Statistics
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Agents, runs, spend and throughput across your repositories.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Repository"
            className={select}
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          >
            <option value="">All repositories</option>
            {boards.map((item) => (
              <option key={item.id} value={item.repo}>
                {repoName(item.repo)}
              </option>
            ))}
          </select>
          <select
            aria-label="Time range"
            className={select}
            value={range}
            onChange={(event) => setRange(event.target.value)}
          >
            {ranges.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="space-y-4 px-6 py-6 lg:px-10">
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        {!stats && !error && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
        {stats && summary && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Tile
                label="Spend"
                value={formatCost(summary.cost)}
                hint={`${compact.format(summary.tokens)} tokens`}
              />
              <Tile
                label="Runs"
                value={String(summary.runs)}
                hint={`${percent(summary.autoShare)} started automatically`}
              />
              <Tile
                label="Success rate"
                value={percent(summary.successRate)}
                hint="Runs that did not fail"
              />
              <Tile
                label="Avg run time"
                value={minutes(summary.avgRunMinutes)}
              />
              <Tile
                label="Cards created"
                value={String(summary.cardsCreated)}
              />
              <Tile
                label="Cards done"
                value={String(summary.cardsDone)}
                hint={`${hours(summary.avgLeadHours)} average from creation`}
              />
              <Tile
                label="Review rounds"
                value={String(summary.reviewRounds)}
                hint={`${summary.ciReworks} sent back for CI`}
              />
              <Tile
                label="Agent reviews"
                value={String(summary.agentReviews)}
                hint={`${summary.agentReviewsMerged} merged`}
              />
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Panel
                title="Runs per day"
                description="Outcome of each run, by the day it started."
              >
                <ChartContainer
                  config={runsConfig}
                  className="aspect-auto h-64 w-full"
                >
                  <BarChart data={stats.daily}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={tick}
                      minTickGap={24}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={28}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={<ChartTooltipContent labelFormatter={tick} />}
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar
                      dataKey="succeeded"
                      stackId="runs"
                      fill="var(--color-succeeded)"
                    />
                    <Bar
                      dataKey="interrupted"
                      stackId="runs"
                      fill="var(--color-interrupted)"
                    />
                    <Bar
                      dataKey="failed"
                      stackId="runs"
                      fill="var(--color-failed)"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              </Panel>
              <Panel
                title="Spend per day"
                description="Run and agent review cost."
              >
                <ChartContainer
                  config={spendConfig}
                  className="aspect-auto h-64 w-full"
                >
                  <AreaChart data={stats.daily}>
                    <defs>
                      <linearGradient
                        id="spend-fill"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor="var(--color-cost)"
                          stopOpacity={0.5}
                        />
                        <stop
                          offset="95%"
                          stopColor="var(--color-cost)"
                          stopOpacity={0.05}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={tick}
                      minTickGap={24}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tickFormatter={(value: number) => formatCost(value)}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          labelFormatter={tick}
                          valueFormatter={(value) => `$${value.toFixed(2)}`}
                        />
                      }
                    />
                    <Area
                      dataKey="cost"
                      type="monotone"
                      stroke="var(--color-cost)"
                      fill="url(#spend-fill)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ChartContainer>
              </Panel>
              <Panel
                title="Cards created and done"
                description="Throughput by day. A card counts as done on its last update."
              >
                <ChartContainer
                  config={flowConfig}
                  className="aspect-auto h-64 w-full"
                >
                  <LineChart data={stats.daily}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={tick}
                      minTickGap={24}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={28}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={<ChartTooltipContent labelFormatter={tick} />}
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Line
                      dataKey="created"
                      type="monotone"
                      stroke="var(--color-created)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      dataKey="done"
                      type="monotone"
                      stroke="var(--color-done)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ChartContainer>
              </Panel>
              <Panel
                title="Tokens"
                description="Where the tokens went in the selected range."
              >
                <ChartContainer
                  config={tokenConfig}
                  className="aspect-auto h-64 w-full"
                >
                  <BarChart data={tokenRows}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="kind" tickLine={false} axisLine={false} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tickFormatter={(value: number) => compact.format(value)}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          valueFormatter={(value) =>
                            value.toLocaleString("en-US")
                          }
                        />
                      }
                    />
                    <Bar
                      dataKey="tokens"
                      fill="var(--color-tokens)"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              </Panel>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Breakdown
                title="By agent"
                rows={stats.byAgent}
                label={(name) => name}
              />
              <Breakdown
                title="By repository"
                rows={stats.byRepo}
                label={repoName}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
