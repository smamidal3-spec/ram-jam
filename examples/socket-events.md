# Socket Event Examples

## Join Session
```json
{
  "event": "JOIN_SESSION",
  "payload": { "sessionId": "A1B2C3" }
}
```

## Control Event (Host)
```json
{
  "event": "CONTROL_EVENT",
  "payload": {
    "sessionId": "A1B2C3",
    "type": "SEEK",
    "videoId": "dQw4w9WgXcQ",
    "time": 42.5
  }
}
```

## Queue Add
```json
{
  "event": "ADD_TO_QUEUE",
  "payload": {
    "sessionId": "A1B2C3",
    "videoItem": {
      "videoId": "dQw4w9WgXcQ",
      "title": "Song Title",
      "thumbnail": "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
    }
  }
}
```
