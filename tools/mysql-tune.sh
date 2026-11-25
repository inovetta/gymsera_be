#!/bin/sh
# Run after every start of the local gymsera-test-mysql57 container.
set -eu

container=gymsera-test-mysql57
if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
  echo "$container is not running" >&2
  exit 1
fi

docker exec "$container" mysql -uroot -e \
  'SET GLOBAL innodb_buffer_pool_size=67108864; SET GLOBAL table_open_cache=400; SET GLOBAL table_definition_cache=400;'
