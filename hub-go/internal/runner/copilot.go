package runner

import (
	"errors"
	"fmt"
)

// copilotAdapter: GitHub Copilot，GET /copilot_internal/user（社区常用接口，非官方）。
type copilotAdapter struct{}

func (copilotAdapter) Provider() string { return "copilot" }

func (copilotAdapter) Fetch(cred map[string]string) ([]Row, error) {
	token := cred["token"]
	if token == "" {
		return nil, errors.New("missing credential: token (GitHub personal token)")
	}
	var json struct {
		Plan *struct {
			Usage *struct {
				Limit     *float64 `json:"limit"`
				Used      any      `json:"used"`
				Remaining *float64 `json:"remaining"`
			} `json:"usage"`
		} `json:"plan"`
	}
	if err := getJSON("https://api.github.com/copilot_internal/user", map[string]string{
		"Authorization": "Bearer " + token,
		"User-Agent":    "tokendash-runner",
	}, &json); err != nil {
		return nil, fmt.Errorf("copilot user: %w", err)
	}
	usage := json.Plan.Usage
	if usage == nil {
		return nil, errors.New("copilot: no plan.usage in response")
	}
	rows := []Row{{
		Provider: "copilot",
		Metric:   "premium_used",
		Value:    num(usage.Used),
		Unit:     strptr("requests"),
	}}
	if usage.Limit != nil {
		rows[0].LimitValue = usage.Limit
	}
	if usage.Remaining != nil {
		rows = append(rows, Row{
			Provider:   "copilot",
			Metric:     "premium_remaining",
			Value:      *usage.Remaining,
			Unit:       strptr("requests"),
			LimitValue: usage.Limit,
		})
	}
	return rows, nil
}
