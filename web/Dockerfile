FROM nginx:alpine

# Copy static frontend files to Nginx html directory
COPY index.html /usr/share/nginx/html/index.html
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js

# Copy Nginx configuration with reverse proxy to FastAPI backend
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
