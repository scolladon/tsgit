window.BENCHMARK_DATA = {
  "lastUpdate": 1783780660821,
  "repoUrl": "https://github.com/scolladon/tsgit",
  "entries": {
    "tsgit benchmarks": [
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "325a53b41e328f5f406275ee576eaaf439801d23",
          "message": "feat: notes — git-faithful add/read/list/remove on refs/notes/* (#204)",
          "timestamp": "2026-06-29T15:13:15+02:00",
          "tree_id": "8bf9e13a3ee00af7a01ee98ef4886ff3ecc16252",
          "url": "https://github.com/scolladon/tsgit/commit/325a53b41e328f5f406275ee576eaaf439801d23"
        },
        "date": 1783008548250,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.09959200000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.55252749999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1594.8814589999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 902.2597365000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.440629000000058,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.181056499999954,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.670669999999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.46374699999978,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.36537799999996423,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 94.18402049999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6122004999999717,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.43561700000009296,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32288900000003196,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3385370000000876,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7179.782471499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2913.136057000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.285153500000206,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.416537000000062,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.714465500000188,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.530068000000028,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "eb253e9ef35ff60fa7d111863702888ebb98c4be",
          "message": "chore(main): release 3.0.0 (#119)",
          "timestamp": "2026-07-02T19:58:35+02:00",
          "tree_id": "b7873e152314b7dac5e059b104c60c85f7e20471",
          "url": "https://github.com/scolladon/tsgit/commit/eb253e9ef35ff60fa7d111863702888ebb98c4be"
        },
        "date": 1783016604065,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.302995999999894,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.04181299999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1725.8805270000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 949.7222769999971,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.874919999999975,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.756335000000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.764230999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.90183100000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.42417150000005677,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.6970809999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5999979999999141,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4528889999999137,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3383899999998903,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38282399999980044,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7835.848864500003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3134.759497000021,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.022527500000024,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.032378999999764,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.10012400000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.541697999999997,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "857039b7153f1434229ad9f9f48ccacdc59ce013",
          "message": "feat: SSH transport for clone, fetch, pull, and push (#207)",
          "timestamp": "2026-07-03T11:44:50+02:00",
          "tree_id": "86e49d40b92a0f47bacbf6f74f0049392b76c125",
          "url": "https://github.com/scolladon/tsgit/commit/857039b7153f1434229ad9f9f48ccacdc59ce013"
        },
        "date": 1783073433878,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 30.070412999999917,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.563625000000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1797.0242909999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 962.3422009999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.328525000000127,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.244061999999758,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.3143634999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 100.89593100000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.42219449999970493,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.90911400000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5924745000000939,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4082539999999426,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3564724999998816,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3674224999999751,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8147.139441000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3086.2969495001016,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.6575059999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.79384600000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.917275000000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.02115600000002,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "164b2e620ced7ce978b4945b8d847951ee1b8efa",
          "message": "feat: GPG signing — signed commits, tags, and pushes (#209)",
          "timestamp": "2026-07-04T00:06:26+02:00",
          "tree_id": "602cd8f9d4c263dc5117d47b339d1884fc77b716",
          "url": "https://github.com/scolladon/tsgit/commit/164b2e620ced7ce978b4945b8d847951ee1b8efa"
        },
        "date": 1783117893855,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.61536799999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.241895000000113,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1451.2527504999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 777.0151800000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.344720000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.201627999999914,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.60513800000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.93237500000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3117019999999684,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.4309404999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4994000000000369,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3685414999999921,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.28003000000012435,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.31648900000027425,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6700.4674620000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2580.0846305000596,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.704444500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.957413000000088,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.231012499999906,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.51443399999971,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "0bb9e8835ac9e3b58ea442755d65e9c67d2cb8a5",
          "message": "feat: smart-HTTP protocol v2 for fetch and clone, with corrected v1 fallback (#210)",
          "timestamp": "2026-07-05T09:31:50+02:00",
          "tree_id": "4591d2d51ff0f360a954b4d81efe8f3704be0859",
          "url": "https://github.com/scolladon/tsgit/commit/0bb9e8835ac9e3b58ea442755d65e9c67d2cb8a5"
        },
        "date": 1783238236825,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.89751050000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.15968399999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1454.9259614999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 774.4062509999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.55093799999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.347937000000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.381469000000038,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.65483049999989,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.33151900000029855,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.57281449999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5308239999999387,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3504379999999401,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25556699999992816,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34059799999999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6811.477011999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2570.7747140000574,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.211169999999811,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.04891449999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.036665999999968,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.731039500000179,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sébastien Colladon",
            "username": "scolladon"
          },
          "committer": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sébastien Colladon",
            "username": "scolladon"
          },
          "distinct": true,
          "id": "1656f98fd742d7dba2cc365ef4563f5695d9ae15",
          "message": "docs: reorder Phase 26 backlog into execution sequence",
          "timestamp": "2026-07-05T23:01:14+02:00",
          "tree_id": "f7c1ce3d4cb1f7d2b342a0a6db034a19b2532f53",
          "url": "https://github.com/scolladon/tsgit/commit/1656f98fd742d7dba2cc365ef4563f5695d9ae15"
        },
        "date": 1783286834947,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.29101300000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.489497000000256,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1659.4892595000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 902.8206190000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.541187500000092,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.762114999999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.790656499999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.7119715,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.37978449999991426,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.13935500000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5302675000000363,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.39253899999994246,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.29235000000016953,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3459509999997863,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7366.217122000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2979.956292000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.910802999999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.643263999999817,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.597089000000096,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.647690999999895,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "69dabf51cc2396c9d815b021fb82705c7b168871",
          "message": "refactor: centralize magic literals into named constants (#211)",
          "timestamp": "2026-07-06T09:47:26+02:00",
          "tree_id": "e2bca1e8d244e75e8e0cdc04c8882bc988520a97",
          "url": "https://github.com/scolladon/tsgit/commit/69dabf51cc2396c9d815b021fb82705c7b168871"
        },
        "date": 1783325481325,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 42.15275699999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 49.77532250000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1190.313302999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 610.5385435000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.565268999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.631575999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.858181000000059,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 64.1488865,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25343100000009144,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 67.70911649999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3753554999999551,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.2756960000001527,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2035519999999451,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.22976649999986876,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5421.967176999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2047.7368060001172,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.048128999999903,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.272261999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.441587000000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.990070499999774,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "f73f9a100a93d0a00a285b9ebc5899e175db3f3e",
          "message": "feat: git-faithful branch/remote and push.default resolution (#215)",
          "timestamp": "2026-07-07T09:12:11+02:00",
          "tree_id": "4910452fad5cdfda4b8f7f24cfb6f87b78f371fb",
          "url": "https://github.com/scolladon/tsgit/commit/f73f9a100a93d0a00a285b9ebc5899e175db3f3e"
        },
        "date": 1783409866889,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.274282500000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.459716999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1440.7849590000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 782.274998500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.542378499999927,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.246268999999756,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.375525000000152,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.95912850000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32033599999977014,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 82.78550099999961,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5065640000000258,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34195899999997437,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25385800000003655,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.29795850000004975,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6651.849907499996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2551.1052990001626,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.691877499999919,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.632134499999893,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.833270999999968,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.393597000000227,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7a1dd5d493a3607ef3778a116a93d607aa618156",
          "message": "feat: zero-dependency inflate decoder for browser/memory large-entry pack clone (#216)",
          "timestamp": "2026-07-07T17:31:46+02:00",
          "tree_id": "08681398f4454df9e1bb999fdfd37651aa3f7345",
          "url": "https://github.com/scolladon/tsgit/commit/7a1dd5d493a3607ef3778a116a93d607aa618156"
        },
        "date": 1783439847184,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.322959000000083,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.320606000000225,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1753.6681500000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 965.5691689999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.28833499999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.568041999999878,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.07088349999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.13374249999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.39766400000007707,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.11791700000049,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5483159999998861,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4549765000001571,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3427209999999832,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.40505800000005365,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8008.636555500005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3123.5183709999546,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.242886,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.389289999999619,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.15214500000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.093461000000389,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "c83b9326ebd3fdfb2637bee62b34375a725f82d1",
          "message": "docs: spike streaming streamInflate output cap (#217)",
          "timestamp": "2026-07-07T23:38:02+02:00",
          "tree_id": "7c7ddb3de19568f51674ad8be4a162bdd5448be4",
          "url": "https://github.com/scolladon/tsgit/commit/c83b9326ebd3fdfb2637bee62b34375a725f82d1"
        },
        "date": 1783461836866,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.174343000000135,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.29205950000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1678.944772499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 911.5363350000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.298334999999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.401116499999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.141761999999972,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.34340250000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3969094999999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.20548600000029,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5315630000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4048539999998866,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.36166300000013507,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4164304999999331,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7546.699162499997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3296.3344459999353,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.961493000000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.022001000000046,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.115614000000278,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.10607449999975,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "b10ac0f725297e6158f6e17450b2a2e446f24270",
          "message": "docs: drop stale workers-types filter note from manifest (#218)",
          "timestamp": "2026-07-08T19:04:25+02:00",
          "tree_id": "400b063557810a0fb8de617ef0b1292616baf20c",
          "url": "https://github.com/scolladon/tsgit/commit/b10ac0f725297e6158f6e17450b2a2e446f24270"
        },
        "date": 1783531870241,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.395217499999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.36812800000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1740.1186779999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 957.5200594999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 21.91061949999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.676840500000253,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.033415000000105,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.78709650000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3804939999999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.35094850000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.601291999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3757894999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.35324199999968187,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3764059999998608,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8107.8813095000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3188.554305999889,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.171231999999918,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.181072999999742,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.56600599999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.19520999999986,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "732005096439b36ae3449776feb5c92a6f053d05",
          "message": "perf: describe early-termination traversal breaks (#219)",
          "timestamp": "2026-07-09T19:47:28+02:00",
          "tree_id": "ba2b7f4ae6372a9bf33ce5205a0c0c0aeeba0789",
          "url": "https://github.com/scolladon/tsgit/commit/732005096439b36ae3449776feb5c92a6f053d05"
        },
        "date": 1783620677341,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.558487499999956,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 39.398983000000044,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 4.839634500000045,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1103.1923235000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 618.6766674999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.10098599999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.062677000000122,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.118800999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.66420700000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.22956999999996697,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.8948155000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.40396099999998114,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.25573449999990316,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.20616549999976996,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.24927699999989272,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6067.305302500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2417.0865540000377,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.464371000000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.246236999999837,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.421185500000092,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.395064000000275,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5af3f455c2821e235149a749ffe6cd866e9e7316",
          "message": "perf: prune name-rev walk at the target date cutoff (#220)",
          "timestamp": "2026-07-09T21:25:32+02:00",
          "tree_id": "864be0622f811874306b9d56f297611a7faad87e",
          "url": "https://github.com/scolladon/tsgit/commit/5af3f455c2821e235149a749ffe6cd866e9e7316"
        },
        "date": 1783626724240,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.12464200000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.264506499999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.349204500000042,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1763.9948949999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 961.3803404999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.03063700000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.231707000000142,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.7758284999999887,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.679458000000068,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 100.39199150000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3640720000003057,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.79284349999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5719609999998738,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4240439999998671,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3224645000000237,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3577700000000732,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8235.3115985,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3324.5810094999615,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.778802999999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.609230999999909,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.346947,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.499330500000042,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "43830781172b67c7d236d9fd75dc14a9dd894a3e",
          "message": "perf: migrate the commit priority-queue to an O(N log N) binary heap (#221)",
          "timestamp": "2026-07-10T09:20:19+02:00",
          "tree_id": "e0ae2abdb47110f93b256641041a13954b4b7564",
          "url": "https://github.com/scolladon/tsgit/commit/43830781172b67c7d236d9fd75dc14a9dd894a3e"
        },
        "date": 1783669578251,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.564744000000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.231930499999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.20085000000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1792.067652499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 956.8660605000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.644178999999895,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.859231000000364,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.685766000000058,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.573722999999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.15825200000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.39152100000001155,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.33460950000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6912720000000263,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.41898300000002564,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3308234999999513,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42124699999976656,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7989.658066999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3422.537743999972,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.074589999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.44623700000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.96225800000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.316294000000198,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "fc0105ff0bed1343f5ae7104ceb967763636bf35",
          "message": "perf: stop shipping source maps to shrink the npm tarball ~2× (#222)",
          "timestamp": "2026-07-10T11:15:20+02:00",
          "tree_id": "d3d7cdd097fda30ce2c131e9a42e4c2257a5dee0",
          "url": "https://github.com/scolladon/tsgit/commit/fc0105ff0bed1343f5ae7104ceb967763636bf35"
        },
        "date": 1783676491099,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.951902000000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.263492499999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.880758999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1814.5562354999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 944.1631369999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.987138500000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.138344999999845,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.925590999999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.048005999999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.4461859999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.37649099999998725,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.43396200000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.609335000000101,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4425745000000916,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32655800000020463,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4139709999999468,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8139.436511,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3130.3074730000226,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.540230000000065,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.288460000000214,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.31499800000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.248450999999932,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7ad7d4fabce0d3e8d22cf4de73260248d6eb953d",
          "message": "test(bench): add memory-pressure scenarios (large packs, deep delta chains) (#223)",
          "timestamp": "2026-07-10T16:51:52+02:00",
          "tree_id": "7529a0436503832015dc439704143d47423bc924",
          "url": "https://github.com/scolladon/tsgit/commit/7ad7d4fabce0d3e8d22cf4de73260248d6eb953d"
        },
        "date": 1783695652995,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.47195399999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 29.07001000000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.054581999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6273959999998624,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.131901999999855,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6573100000000522,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.680025,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1740.0652309999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 934.7186785000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.7552905,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.10456000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.686202499999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.070421000000351,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 91.72905150000042,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4130929999992077,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.78485099999943,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5565010000000257,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.41532200000006014,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3426209999997809,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4259669999999005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7912.9562425,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3223.193365500003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.441269499999976,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.966781999999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.838624999999865,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.295768499999895,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "6f52886f05c610e59bc7986cf67567ea2271e996",
          "message": "chore(profile): per-command profile capture and committed baseline (#224)",
          "timestamp": "2026-07-11T16:12:38+02:00",
          "tree_id": "93638e611207099dae00b182027ac452ad28eb30",
          "url": "https://github.com/scolladon/tsgit/commit/6f52886f05c610e59bc7986cf67567ea2271e996"
        },
        "date": 1783780660231,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.06553299999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.388000499999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.499586000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.693277500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.803598000000193,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5999680000002172,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.163614999999936,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1681.498321,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 939.8401555,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.79095099999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.274618499999974,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.871629000000041,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.882119500000272,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 91.77799700000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3609835000002022,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.6235059999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5546360000000732,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42414199999984703,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3587400000001253,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.37835699999959616,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7826.860412000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3424.056595500093,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.061425999999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.9545949999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.746456500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.894084999999905,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}