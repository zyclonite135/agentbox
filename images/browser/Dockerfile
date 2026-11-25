# Optional workspace image with a real desktop browser. Build the agent image first.
ARG AGENT_IMAGE=agentbox-agent:latest
FROM ${AGENT_IMAGE}
USER root
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      tigervnc-standalone-server openbox x11-utils xclip fonts-noto-cjk fonts-liberation \
      libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 \
      libgtk-3-0 libxss1 libu2f-udev \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends wmctrl \
    && rm -rf /var/lib/apt/lists/*
# Set by scripts/build-browser-image.sh from the official Stable channel.
ARG CHROME_VERSION
RUN case "$(dpkg --print-architecture)" in \
      amd64) chrome_platform=linux64 ;; \
      arm64) chrome_platform=linux-arm64 ;; \
      *) echo 'Chrome for Testing requires Linux amd64 or arm64' >&2; exit 1 ;; \
    esac \
    && curl --proto '=https' --proto-redir '=https' --fail --show-error --location --retry 3 \
        "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION:?Build with scripts/build-browser-image.sh}/$chrome_platform/chrome-$chrome_platform.zip" \
        -o /tmp/chrome.zip \
    && unzip -q /tmp/chrome.zip -d /opt \
    && test -x "/opt/chrome-$chrome_platform/chrome" \
    && ln -s "/opt/chrome-$chrome_platform/chrome" /usr/local/bin/agentbox-browser \
    && rm -f /tmp/chrome.zip
COPY browser.py /opt/agentbox/browser.py
COPY tab-favicons/ /opt/agentbox/tab-favicons/
LABEL agentbox.browser="1"
# manager.go selects the narrow user-namespace seccomp profile for this image;
# Chrome's sandbox stays enabled. No VNC/CDP port is published.
