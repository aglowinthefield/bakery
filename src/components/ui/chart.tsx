import * as React from "react";
import * as Recharts from "recharts";
import { cn } from "../../lib/utils";

// shadcn/ui's chart primitive, trimmed to what Bakery uses. Series colors come from the config as CSS variables.
export type ChartConfig = Record<
  string,
  { label?: React.ReactNode; color?: string }
>;
const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);
const useChart = () => {
  const context = React.useContext(ChartContext);
  if (!context)
    throw new Error("useChart must be used within a ChartContainer");
  return context;
};

export function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<
    typeof Recharts.ResponsiveContainer
  >["children"];
}) {
  const chartId = `chart-${id ?? React.useId().replace(/:/g, "")}`;
  const colors = Object.entries(config).filter(([, item]) => item.color);
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/50 [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden",
          className,
        )}
        {...props}
      >
        <style
          dangerouslySetInnerHTML={{
            __html: `[data-chart=${chartId}] {\n${colors.map(([key, item]) => `  --color-${key}: ${item.color};`).join("\n")}\n}`,
          }}
        />
        <Recharts.ResponsiveContainer>{children}</Recharts.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = Recharts.Tooltip;

type TooltipItem = {
  dataKey?: string | number;
  name?: string | number;
  value?: unknown;
  color?: string;
  payload?: Record<string, unknown>;
};
export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  className,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: React.ReactNode;
  className?: string;
  labelFormatter?: (label: string) => React.ReactNode;
  valueFormatter?: (value: number, key: string) => React.ReactNode;
}) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  const heading =
    label === undefined
      ? undefined
      : labelFormatter
        ? labelFormatter(String(label))
        : label;
  return (
    <div
      className={cn(
        "grid min-w-32 gap-1.5 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-xl",
        className,
      )}
    >
      {heading ? <div className="font-medium">{heading}</div> : null}
      <div className="grid gap-1">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name);
          const entry = config[key];
          return (
            <div key={key} className="flex items-center gap-2">
              <span
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: item.color ?? entry?.color }}
              />
              <span className="text-muted-foreground">
                {entry?.label ?? item.name}
              </span>
              <span className="ml-auto pl-4 font-mono font-medium tabular-nums">
                {valueFormatter && typeof item.value === "number"
                  ? valueFormatter(item.value, key)
                  : String(item.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ChartLegend = Recharts.Legend;
export function ChartLegendContent({
  payload,
  className,
}: {
  payload?: { dataKey?: unknown; value?: unknown; color?: string }[];
  className?: string;
}) {
  const { config } = useChart();
  if (!payload?.length) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-4 pt-3",
        className,
      )}
    >
      {payload.map((item) => {
        const key = String(item.dataKey ?? item.value);
        return (
          <div
            key={key}
            className="flex items-center gap-1.5 text-muted-foreground"
          >
            <span
              className="size-2 rounded-[2px]"
              style={{ background: item.color }}
            />
            {config[key]?.label ?? String(item.value)}
          </div>
        );
      })}
    </div>
  );
}
