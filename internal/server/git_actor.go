package server

import "agentbox/internal/store"

func gitActor(c store.GitConnection) string {
	if c.Actor != "" {
		return c.Actor
	}
	return c.Owner
}
