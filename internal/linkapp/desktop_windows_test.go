package linkapp

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestFitPanelWindow(t *testing.T) {
	tests := []struct {
		name      string
		bounds    application.Rect
		workArea  application.Rect
		preferred application.Size
		want      application.Rect
	}{
		{
			name:      "keep position when the larger view fits",
			bounds:    application.Rect{X: 100, Y: 120, Width: 650, Height: 460},
			workArea:  application.Rect{Width: 1920, Height: 1040},
			preferred: application.Size{Width: 1180, Height: 780},
			want:      application.Rect{X: 100, Y: 120, Width: 1180, Height: 780},
		},
		{
			name:      "keep the expanded window within a secondary monitor",
			bounds:    application.Rect{X: -650, Y: 225, Width: 650, Height: 460},
			workArea:  application.Rect{X: -1440, Y: 40, Width: 1440, Height: 860},
			preferred: application.Size{Width: 1180, Height: 780},
			want:      application.Rect{X: -1180, Y: 120, Width: 1180, Height: 780},
		},
		{
			name:      "use the available area on a small monitor",
			bounds:    application.Rect{X: 50, Y: 90, Width: 650, Height: 460},
			workArea:  application.Rect{X: 48, Y: 20, Width: 760, Height: 600},
			preferred: application.Size{Width: 1180, Height: 780},
			want:      application.Rect{X: 48, Y: 20, Width: 760, Height: 600},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := fitPanelWindow(test.bounds, test.workArea, test.preferred); got != test.want {
				t.Errorf("fitPanelWindow() = %+v, want %+v", got, test.want)
			}
		})
	}
}
