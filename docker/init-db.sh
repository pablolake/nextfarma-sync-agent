#!/bin/bash
set -e

echo "Esperando a SQL Server..."
for i in $(seq 1 30); do
  /opt/mssql-tools18/bin/sqlcmd -S sqlserver -U SA -P "$SA_PASSWORD" -Q "SELECT 1" -C -b > /dev/null 2>&1 && break
  echo "  intento $i/30..."
  sleep 2
done

echo "Ejecutando init SQL..."
/opt/mssql-tools18/bin/sqlcmd -S sqlserver -U SA -P "$SA_PASSWORD" -i /farmatic-test.sql -C -b
echo "DB inicializada"
