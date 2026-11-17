package main

import (
	"context"
	"net/http"
	"net/url"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
)

type directoryOperations interface {
	Me(context.Context, string) (auth.User, error)
	Search(context.Context, string, string) ([]auth.UserSummary, error)
	Contacts(context.Context, string) ([]auth.UserSummary, error)
	AddContact(context.Context, string, string) error
	RemoveContact(context.Context, string, string) error
}

type directoryAPI struct{ service directoryOperations }

func newDirectoryHandler(service directoryOperations, verifier *jwtauth.Verifier) http.Handler {
	api := directoryAPI{service: service}
	mux := http.NewServeMux()
	for _, route := range []struct {
		pattern string
		handler http.HandlerFunc
	}{
		{"GET /me", api.me}, {"GET /users/search", api.search}, {"GET /contacts", api.contacts},
		{"PUT /contacts/{contact_id}", api.addContact}, {"DELETE /contacts/{contact_id}", api.removeContact},
	} {
		mux.Handle(route.pattern, verifier.Middleware(route.handler))
	}
	return mux
}
func identityID(r *http.Request) string {
	identity, _ := jwtauth.FromContext(r.Context())
	return identity.UserID
}
func (api directoryAPI) me(w http.ResponseWriter, r *http.Request) {
	user, err := api.service.Me(r.Context(), identityID(r))
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, user)
}
func (api directoryAPI) search(w http.ResponseWriter, r *http.Request) {
	query, err := parseSearchPrefix(r)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	users, err := api.service.Search(r.Context(), identityID(r), query)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"users": users})
}
func parseSearchPrefix(r *http.Request) (string, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query["prefix"]) != 1 {
		return "", &auth.ValidationError{Details: []auth.FieldError{{Field: "prefix", Reason: "Передайте один параметр prefix."}}}
	}
	return query.Get("prefix"), nil
}
func (api directoryAPI) contacts(w http.ResponseWriter, r *http.Request) {
	contacts, err := api.service.Contacts(r.Context(), identityID(r))
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"contacts": contacts})
}
func (api directoryAPI) addContact(w http.ResponseWriter, r *http.Request) {
	if err := api.service.AddContact(r.Context(), identityID(r), r.PathValue("contact_id")); err != nil {
		writeAuthError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (api directoryAPI) removeContact(w http.ResponseWriter, r *http.Request) {
	if err := api.service.RemoveContact(r.Context(), identityID(r), r.PathValue("contact_id")); err != nil {
		writeAuthError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
