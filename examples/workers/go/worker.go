// sched HTTP worker example — Go (stdlib net/http, zero dependencies).
//
// Implements the sched runner protocol (docs/content/docs/05.protocol.md):
//   - POST /            dispatch envelope { task: { name, config }, data }
//   - GET /status/:id   async poll endpoint (same outbound auth)
//
// Tasks:
//   - "ping"  sync:  200 { status: "succeeded"|"failed", ... }
//   - "long"  async: 202 { status: "accepted", statusUrl, pollIntervalMs } →
//                    GET statusUrl → running with progress → terminal envelope
//
// Auth (G1): when SCHED_API_KEY is set, every endpoint requires
// `x-sched-api-key` to match (else 401). Unset → validation skipped.
// Idempotency: results are stored by `x-sched-run-id`; a redelivery of the
// same run id answers with the saved outcome instead of re-executing.
//
// Run: go run .   (port: SCHED_PORT, default 8080)
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// RequestEnvelope is the wire envelope the daemon POSTs (runner protocol).
type RequestEnvelope struct {
	Task struct {
		Name   string         `json:"name"`
		Config map[string]any `json:"config"`
	} `json:"task"`
	Data map[string]any `json:"data"`
}

// State is what the worker persists per run id and what poll returns.
type State struct {
	Status   string         `json:"status"`
	Progress int            `json:"progress"`
	Log      string         `json:"log,omitempty"`
	Result   map[string]any `json:"result,omitempty"`
	Error    string         `json:"error,omitempty"`
}

var (
	stateMu sync.Mutex
	runs    = map[string]*State{}
)

var apiKey = os.Getenv("SCHED_API_KEY")

func baseURL(r *http.Request) string {
	if u := os.Getenv("SCHED_BASE_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func workMs(data map[string]any, def int) int {
	if v, ok := data["workMs"].(float64); ok && v > 0 {
		return int(v)
	}
	return def
}

func shouldFail(data map[string]any) bool {
	f, _ := data["fail"].(bool)
	return f
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func checkAuth(w http.ResponseWriter, r *http.Request) bool {
	if apiKey == "" {
		return true
	}
	if r.Header.Get("x-sched-api-key") != apiKey {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return false
	}
	return true
}

func dispatch(w http.ResponseWriter, r *http.Request) {
	if !checkAuth(w, r) {
		return
	}
	var env RequestEnvelope
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON envelope"})
		return
	}
	runID := r.Header.Get("x-sched-run-id")
	if runID == "" {
		// The daemon always sends the run id; a missing one gets a unique
		// fallback so two anonymous calls never share dedupe state.
		runID = fmt.Sprintf("anon-%d", time.Now().UnixNano())
	}
	if env.Task.Name == "long" {
		handleAsync(w, r, runID, env)
		return
	}
	handleSync(w, r, runID, env)
}

func handleSync(w http.ResponseWriter, _ *http.Request, runID string, env RequestEnvelope) {
	data := env.Data
	stateMu.Lock()
	if existing, ok := runs[runID]; ok { // redelivery → saved outcome
		stateMu.Unlock()
		writeJSON(w, http.StatusOK, existing)
		return
	}
	stateMu.Unlock()

	time.Sleep(time.Duration(workMs(data, 100)) * time.Millisecond)

	var state *State
	if shouldFail(data) {
		state = &State{Status: "failed", Progress: 100, Error: "worker failed on purpose (data.fail=true)", Log: "ping failed as requested"}
	} else {
		state = &State{Status: "succeeded", Progress: 100, Result: map[string]any{"task": env.Task.Name, "data": data, "echo": "pong"}, Log: "ping ok"}
	}
	stateMu.Lock()
	runs[runID] = state
	stateMu.Unlock()
	writeJSON(w, http.StatusOK, state)
}

func handleAsync(w http.ResponseWriter, r *http.Request, runID string, env RequestEnvelope) {
	data := env.Data
	statusURL := baseURL(r) + "/status/" + runID

	stateMu.Lock()
	if existing, ok := runs[runID]; ok { // redelivery of an in-flight or finished run
		stateMu.Unlock()
		if existing.Status == "queued" || existing.Status == "running" {
			writeJSON(w, http.StatusAccepted, map[string]any{"status": "accepted", "statusUrl": statusURL, "pollIntervalMs": 500})
		} else {
			writeJSON(w, http.StatusOK, existing)
		}
		return
	}
	state := &State{Status: "queued", Progress: 0, Log: "accepted"}
	runs[runID] = state
	stateMu.Unlock()

	ms := workMs(data, 150)
	fail := shouldFail(data)
	go func() {
		for p := 20; p <= 100; p += 20 {
			time.Sleep(time.Duration(ms) * time.Millisecond)
			stateMu.Lock()
			state.Status = "running"
			state.Progress = p
			state.Log = fmt.Sprintf("working… %d%%", p)
			stateMu.Unlock()
		}
		stateMu.Lock()
		if fail {
			state.Status = "failed"
			state.Error = "worker failed on purpose (data.fail=true)"
			state.Log = "long task failed as requested"
		} else {
			state.Status = "succeeded"
			state.Result = map[string]any{"task": env.Task.Name, "workMs": ms, "ok": true}
			state.Log = "long task completed"
		}
		state.Progress = 100
		stateMu.Unlock()
	}()

	writeJSON(w, http.StatusAccepted, map[string]any{"status": "accepted", "statusUrl": statusURL, "pollIntervalMs": 500})
}

func handleStatus(w http.ResponseWriter, _ *http.Request, runID string) {
	stateMu.Lock()
	state, ok := runs[runID]
	stateMu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown run id"})
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func main() {
	port := os.Getenv("SCHED_PORT")
	if port == "" {
		port = "8080"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/":
			dispatch(w, r)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/status/"):
			if !checkAuth(w, r) {
				return
			}
			handleStatus(w, r, strings.TrimPrefix(r.URL.Path, "/status/"))
		default:
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		}
	})
	log.Printf("[worker] sched example worker (Go) listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
