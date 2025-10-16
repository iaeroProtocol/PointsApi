.PHONY: up down logs api indexer psql seed curl clean

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

api:
	docker compose logs -f points-api

indexer:
	docker compose logs -f points-indexer

psql:
	docker exec -it iaero-pg psql -U postgres -d iaero

seed:
	# re-run migrations by restarting indexer (it runs migrations on boot)
	docker compose restart points-indexer

curl:
	curl -s http://localhost:8080/health | jq .

clean:
	docker compose down -v
	docker system prune -f

