// Statistics UI contribution (pcms.ui-contribution/v1 pilot, P033). Built-in, so it runs in
// the background Core in process; the dashboard only receives validated, text-only data.
// It reads the accepted P018 projection and adds no new business rules.
const METRIC_VIEW = "metrics";
const DETAIL_VIEW = "metric";

function fold(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

export function createUiContribution({ moduleId = "statistics", service } = {}) {
  if (!service || typeof service.rebuild !== "function" || typeof service.view !== "function" || typeof service.exportCsv !== "function") {
    throw new TypeError("Statistics UI contribution requires the statistics service");
  }

  async function current() {
    const state = await service.rebuild();
    return { state, view: service.view(state) };
  }

  return {
    contractVersion: 1,
    moduleId,
    title: "Statistics",
    description: "Audit-derived metrics rebuilt from the PCMS Audit Journal.",
    icon: "chart",
    nav: { label: "Statistics", order: 50, statusFrom: "summary" },
    actions: [{ id: "export", label: "Export CSV", appliesTo: "module", risk: "READ" }],
    page: {
      views: [
        {
          id: METRIC_VIEW,
          title: "Metrics",
          type: "list",
          columns: [
            { id: "label", label: "Metric", kind: "text" },
            { id: "value", label: "Total", kind: "count" },
            { id: "matched", label: "Matched events", kind: "count" },
            { id: "late", label: "Late events", kind: "count" }
          ],
          rowHref: DETAIL_VIEW,
          actions: ["export"]
        },
        { id: DETAIL_VIEW, title: "Metric", type: "detail", actions: [] }
      ]
    },

    async summary() {
      const { view } = await current();
      const matched = view.metrics.reduce((sum, metric) => sum + metric.matchedEvents, 0);
      return {
        status: view.lateEventCount > 0 ? { token: "INFO", label: "Late events" } : { token: "OK", label: "Up to date" },
        headline: view.metrics.length + " metric" + (view.metrics.length === 1 ? "" : "s") + " · " + matched + " matched events",
        facts: [
          { label: "Metrics", value: String(view.metrics.length) },
          { label: "Journal cursor", value: String(view.cursor) },
          { label: "Late events", value: String(view.lateEventCount) }
        ],
        href: "#/m/" + moduleId
      };
    },

    async search(_ctx, query, limit) {
      const needle = fold(query);
      const { view } = await current();
      return view.metrics
        .filter((metric) => fold(metric.label).includes(needle) || fold(metric.metricId).includes(needle))
        .slice(0, limit)
        .map((metric) => ({
          entity: { kind: "module-object", moduleId, view: DETAIL_VIEW, id: metric.metricId },
          title: metric.label,
          subtitle: "Statistics metric · " + metric.value + " total",
          score: fold(metric.label).startsWith(needle) ? 90 : 70
        }));
    },

    async conditions() {
      return [];
    },

    async listRows(_ctx, viewId) {
      if (viewId !== METRIC_VIEW) throw new TypeError("Unknown statistics view");
      const { view } = await current();
      return {
        rows: view.metrics.slice(0, 100).map((metric) => ({
          id: metric.metricId,
          cells: { label: metric.label, value: metric.value, matched: metric.matchedEvents, late: metric.lateMatchedEvents }
        })),
        next: null
      };
    },

    async getDetail(_ctx, viewId, metricId) {
      if (viewId !== DETAIL_VIEW) throw new TypeError("Unknown statistics view");
      const { view } = await current();
      const metric = view.metrics.find((item) => item.metricId === metricId);
      if (!metric) throw new TypeError("Unknown metric");
      return {
        title: metric.label,
        sections: [
          {
            title: "Totals",
            facts: [
              { label: "Aggregation", value: metric.aggregation },
              { label: "Total", value: String(metric.value) },
              { label: "Matched events", value: String(metric.matchedEvents) },
              { label: "Late events", value: String(metric.lateMatchedEvents) }
            ]
          },
          {
            title: "Recent days",
            facts: metric.series.slice(-12).map((bucket) => ({ label: bucket.day, value: String(bucket.value) }))
          }
        ]
      };
    },

    async invoke(_ctx, actionId) {
      if (actionId !== "export") throw new TypeError("Unknown statistics action");
      const { state } = await current();
      const text = service.exportCsv(state);
      return {
        status: { token: "OK", label: "Exported" },
        message: "Statistics CSV is ready.",
        download: { filename: "pcms-statistics.csv", mediaType: "text/csv", text }
      };
    }
  };
}
