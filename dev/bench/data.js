window.BENCHMARK_DATA = {
  "lastUpdate": 1783117894365,
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
      }
    ]
  }
}