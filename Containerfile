FROM docker.io/library/archlinux:latest

# 1. Update the system and install systemd + basic tools
RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm systemd dbus sudo cifs-utils imagemagick nano pam nodejs-lts-krypton npm && \
    pacman -Scc --noconfirm

# 2. Inform systemd that it is running inside an OCI container
ENV container=podman

ENV TZ=America/Chicago
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone


# 3. Clean up unnecessary systemd services that cause issues in containers
RUN rm -f /lib/systemd/system/multi-user.target.wants/*; \
    rm -f /etc/systemd/system/*.wants/*; \
    rm -f /lib/systemd/system/local-fs.target.wants/*; \
    rm -f /lib/systemd/system/sockets.target.wants/*udev*; \
    rm -f /lib/systemd/system/sockets.target.wants/*initctl*; \
    rm -f /lib/systemd/system/basic.target.wants/*; \
    rm -f /lib/systemd/system/anaconda.target.wants/*; \
    rm -f /lib/systemd/system/plymouth*; \
    rm -f /lib/systemd/system/systemd-update-utmp*

COPY filesync.* /etc/systemd/system/

COPY photo.service /etc/systemd/system/

COPY syncscript.sh /usr/local/bin/syncscript

RUN chmod +x /usr/local/bin/syncscript

# Create necessary runtime directories for PAM and sshd
RUN mkdir -p /run/utmp /var/run/utmp /tmp /usr/src/app && \
    chmod 1777 /tmp /run/utmp /var/run/utmp /usr/src/app

WORKDIR /usr/src/app

COPY package.json .

RUN npm install
RUN npm ci --omit=dev

COPY server.js .
COPY .env .

EXPOSE 3000

RUN systemctl enable filesync.timer \
    && systemctl enable photo
