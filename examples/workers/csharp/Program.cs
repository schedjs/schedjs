// sched HTTP worker example — C# minimal API (.NET SDK), no external NuGet packages.
//
// Implements the sched runner protocol (docs/content/docs/05.protocol.md):
//   - POST /            dispatch envelope { task: { name, config }, data }
//   - GET /status/:id   async poll endpoint (same outbound auth)
//
// Tasks:
//   - "ping"  sync:  200 { status: "succeeded"|"failed", ... }
//   - "long"  async: 202 { status: "accepted", statusUrl, pollIntervalMs } ->
//                    GET statusUrl -> running with progress -> terminal envelope
//
// Auth (G1): when SCHED_API_KEY is set, every endpoint requires `x-sched-api-key`
// to match (else 401). Unset -> validation skipped.
// Idempotency: results are stored by `x-sched-run-id`; a redelivery of the same
// run id answers with the saved outcome instead of re-executing.
//
// Run: dotnet run   (port: SCHED_PORT, default 8082)

using System.Collections.Concurrent;
using System.Text.Json;

var apiKey = Environment.GetEnvironmentVariable("SCHED_API_KEY") ?? "";
var baseUrl = (Environment.GetEnvironmentVariable("SCHED_BASE_URL") ?? "").TrimEnd('/');
var port = int.TryParse(Environment.GetEnvironmentVariable("SCHED_PORT"), out var p) && p > 0 ? p : 8082;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// in-memory run state, keyed by run id (idempotency: redelivery -> saved outcome)
var runs = new ConcurrentDictionary<string, State>();

string WorkerBaseUrl(HttpRequest req) =>
    baseUrl.Length > 0 ? baseUrl : $"{req.Scheme}://{req.Host}";

bool AuthOk(HttpRequest req) =>
    apiKey.Length == 0 || req.Headers["x-sched-api-key"].ToString() == apiKey;

static bool Fail(Dictionary<string, JsonElement> data) =>
    data.TryGetValue("fail", out var f) && f.ValueKind == JsonValueKind.True;

static int WorkMs(Dictionary<string, JsonElement> data, int def) =>
    data.TryGetValue("workMs", out var w) && w.TryGetInt32(out var n) && n > 0 ? n : def;

IResult Accepted(HttpRequest req, string runId) =>
    Results.Json(new { status = "accepted", statusUrl = $"{WorkerBaseUrl(req)}/status/{runId}", pollIntervalMs = 500 }, statusCode: 202);

IResult Sync(HttpRequest req, RequestEnvelope env, string runId)
{
    if (runs.TryGetValue(runId, out var existing)) return Results.Json(existing); // redelivery -> saved outcome
    var data = env.Data ?? new();
    Thread.Sleep(WorkMs(data, 100));
    var state = Fail(data)
        ? new State { Status = "failed", Progress = 100, Error = "worker failed on purpose (data.fail=true)", Log = "ping failed as requested" }
        : new State { Status = "succeeded", Progress = 100, Result = new Dictionary<string, object> { ["task"] = env.Task.Name, ["data"] = data, ["echo"] = "pong" }, Log = "ping ok" };
    runs[runId] = state;
    return Results.Json(state);
}

IResult Async(HttpRequest req, RequestEnvelope env, string runId)
{
    var data = env.Data ?? new();
    if (runs.TryGetValue(runId, out var existing)) // redelivery of an in-flight or finished run
    {
        return existing.Status is "queued" or "running"
            ? Accepted(req, runId)
            : Results.Json(existing);
    }
    var state = new State { Status = "queued", Progress = 0, Log = "accepted" };
    runs[runId] = state;
    var ms = WorkMs(data, 150);
    var fail = Fail(data);
    _ = Task.Run(() =>
    {
        for (var p = 20; p <= 100; p += 20)
        {
            Thread.Sleep(ms);
            state.Status = "running";
            state.Progress = p;
            state.Log = $"working… {p}%";
        }
        if (fail)
        {
            state.Status = "failed";
            state.Error = "worker failed on purpose (data.fail=true)";
            state.Log = "long task failed as requested";
        }
        else
        {
            state.Status = "succeeded";
            state.Result = new Dictionary<string, object> { ["task"] = env.Task.Name, ["workMs"] = ms, ["ok"] = true };
            state.Log = "long task completed";
        }
        state.Progress = 100;
    });
    return Accepted(req, runId);
}

app.MapPost("/", async (HttpContext ctx) =>
{
    if (!AuthOk(ctx.Request)) return Results.Json(new { error = "unauthorized" }, statusCode: 401);
    RequestEnvelope? env;
    try { env = await ctx.Request.ReadFromJsonAsync<RequestEnvelope>(); }
    catch { env = null; }
    if (env is null) return Results.Json(new { error = "invalid JSON envelope" }, statusCode: 400);
    var runId = ctx.Request.Headers["x-sched-run-id"].ToString();
    if (string.IsNullOrEmpty(runId)) runId = $"anon-{Guid.NewGuid():N}";
    return env.Task.Name == "long" ? Async(ctx.Request, env, runId) : Sync(ctx.Request, env, runId);
});

app.MapGet("/status/{runId}", (HttpContext ctx, string runId) =>
{
    if (!AuthOk(ctx.Request)) return Results.Json(new { error = "unauthorized" }, statusCode: 401);
    return runs.TryGetValue(runId, out var state)
        ? Results.Json(state)
        : Results.Json(new { error = "unknown run id" }, statusCode: 404);
});

app.Run($"http://0.0.0.0:{port}");

// ---- wire types (runner protocol) ----

sealed class State
{
    public string Status { get; set; } = "";
    public int Progress { get; set; }
    public string? Log { get; set; }
    public Dictionary<string, object>? Result { get; set; }
    public string? Error { get; set; }
}

sealed class RequestEnvelope
{
    public TaskRef Task { get; set; } = new();
    public Dictionary<string, JsonElement>? Data { get; set; }
}

sealed class TaskRef
{
    public string Name { get; set; } = "";
    public Dictionary<string, JsonElement>? Config { get; set; }
}
