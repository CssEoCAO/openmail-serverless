-- Custom SQL migration file, put your code below! --
CREATE TRIGGER oauth_clients_cap BEFORE INSERT ON oauth_clients
WHEN (SELECT COUNT(*) FROM oauth_clients) >= 500
BEGIN SELECT RAISE(ABORT, 'OAuth client capacity reached'); END;
