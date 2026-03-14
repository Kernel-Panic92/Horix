#!/bin/bash

echo "==== Actualizando Horix ===="

cd ~/horix || { echo "No se encontró la carpeta horix"; exit 1; }

echo "---- Descargando cambios del repositorio ----"
git pull origin main

echo "---- Actualizando dependencias ----"
npm install --production

echo "---- Reiniciando servicio ----"
pm2 restart horix

echo "==== Horix actualizado correctamente ===="