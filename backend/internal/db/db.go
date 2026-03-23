package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Todo struct {
	ID        string
	Title     string
	Completed bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

type UpdateTodoParams struct {
	ID        string
	Title     *string
	Completed *bool
}

type Queries struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Queries {
	return &Queries{pool: pool}
}

func (q *Queries) CreateTodo(ctx context.Context, title string) (Todo, error) {
	var t Todo
	err := q.pool.QueryRow(ctx,
		`INSERT INTO todos (title) VALUES ($1)
		 RETURNING id, title, completed, created_at, updated_at`,
		title,
	).Scan(&t.ID, &t.Title, &t.Completed, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

func (q *Queries) ListTodos(ctx context.Context) ([]Todo, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, title, completed, created_at, updated_at
		 FROM todos ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Todo, error) {
		var t Todo
		err := row.Scan(&t.ID, &t.Title, &t.Completed, &t.CreatedAt, &t.UpdatedAt)
		return t, err
	})
}

func (q *Queries) UpdateTodo(ctx context.Context, params UpdateTodoParams) (Todo, error) {
	var t Todo
	err := q.pool.QueryRow(ctx,
		`UPDATE todos
		 SET title = COALESCE($2, title),
		     completed = COALESCE($3, completed),
		     updated_at = NOW()
		 WHERE id = $1
		 RETURNING id, title, completed, created_at, updated_at`,
		params.ID, params.Title, params.Completed,
	).Scan(&t.ID, &t.Title, &t.Completed, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

func (q *Queries) DeleteTodo(ctx context.Context, id string) error {
	_, err := q.pool.Exec(ctx, `DELETE FROM todos WHERE id = $1`, id)
	return err
}
