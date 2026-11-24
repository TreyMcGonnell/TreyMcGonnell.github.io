"""The Supermemory v5 client: request shape, grouping chunks per file, and the used-note policy."""
import json

import httpx

from api.memory import SupermemoryRetriever, retrieve


def fake_api(captured):
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append((request.url.path, json.loads(request.content), request.headers["Authorization"]))
        hit = lambda f, t, s: {"id": f, "chunk": t, "similarity": s, "metadata": {"file": f, "title": f}}  # noqa: E731
        return httpx.Response(200, json={"results": [
            hit("notes/clubs.md", "Trey leads the robotics club.", 0.77),
            hit("notes/clubs.md", "The club meets on Tuesdays.", 0.70),
            hit("notes/youtube.md", "Trey posts coding videos.", 0.66),
            hit("projects/trey-lm.md", "trey-lm visualizes a language model.", 0.52),
        ], "searchTime": 150})
    return httpx.MockTransport(handler)


def test_search_request_and_grouping():
    captured = []
    r = SupermemoryRetriever("sm_test", "https://api.supermemory.ai", "trey-lm", transport=fake_api(captured))
    passages = r.search("What clubs is Trey in?", 4)
    path, body, auth = captured[0]
    assert path == "/ns/trey-lm/search" and body["query"] == "What clubs is Trey in?" and body["searchMode"] == "chunks"
    assert auth == "Bearer sm_test"
    assert [p.file for p in passages] == ["notes/clubs.md", "notes/youtube.md", "projects/trey-lm.md"]
    assert "Tuesdays" in passages[0].text and passages[0].score == 0.77


def test_only_notes_close_to_the_best_match_are_used():
    r = SupermemoryRetriever("k", "https://api.supermemory.ai", "trey-lm", threshold=0.6, margin=0.08, transport=fake_api([]))
    found = retrieve(r, "What clubs is Trey in?", limit=4, use=3, threshold=0.15, timeout_s=2)
    assert [(x["file"], x["used"]) for x in found.results] == [
        ("notes/clubs.md", True), ("notes/youtube.md", False), ("projects/trey-lm.md", False)]


def test_hand_added_documents_are_named_by_their_title():
    def handler(request):
        return httpx.Response(200, json={"results": [{
            "id": "e817dfb32e065658", "chunk": "Trey leads the robotics club.", "similarity": 0.7, "metadata": {},
            "included": {"document": {"id": "3cZcq6bVez", "title": "---\ntitle: Robotics club notes\n---\nTrey leads"}}}]})
    r = SupermemoryRetriever("k", "https://api.supermemory.ai", "trey-lm", transport=httpx.MockTransport(handler))
    assert [p.file for p in r.search("clubs", 4)] == ["Robotics club notes"]


def test_warm_opens_the_connection_and_never_raises():
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={"results": []})
    SupermemoryRetriever("k", "https://api.supermemory.ai", "trey-lm", transport=httpx.MockTransport(handler)).warm()
    assert calls == ["/ns/trey-lm/search"]

    def broken(request):
        raise httpx.ConnectError("offline")
    SupermemoryRetriever("k", "https://api.supermemory.ai", "trey-lm", transport=httpx.MockTransport(broken)).warm()
