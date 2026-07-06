window.BENCHMARK_DATA = {
  "lastUpdate": 1783325481861,
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
      }
    ]
  }
}